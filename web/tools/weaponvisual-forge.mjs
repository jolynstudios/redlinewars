#!/usr/bin/env node
// Original STEELSEED presentation authoring. Offline metadata only; no artwork imports.
// Usage: node web/tools/weaponvisual-forge.mjs [--check|--stdout]
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SOURCE_PATH = 'web/src/core/ra-visual-manifest.json'
export const AUTHORING_PATH = 'web/tools/weaponvisual-forge.mjs'
export const OUTPUT_URL = new URL('../src/weapon-visual-manifest.json', import.meta.url)
export const MAX_PROFILES = 256
const SOURCE_URL = new URL('../src/core/ra-visual-manifest.json', import.meta.url)
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const sha256 = text => createHash('sha256').update(text).digest('hex')

// Every RGB triple is authored directly in LINEAR RGB (not sRGB display values).
// Widths/scales are artistic world-metre presentation envelopes, not measured bores.
// lifetimeSeconds means visual persistence/fade only, NEVER flight time or event delay.
const FAMILIES = {
  bullet:    ['line', [1, .68, .28], 'compact', 'faint', 'chip'],
  mg:        ['line', [1, .8, .4], 'star', 'faint', 'spark'],
  cannon:    ['streak', [1, .52, .14], 'cone', 'puff', 'shell'],
  artillery: ['streak', [1, .38, .08], 'heavy', 'plume', 'heavy-shell'],
  rocket:    ['exhaust', [1, .32, .055], 'exhaust', 'trail', 'blast'],
  torpedo:   ['wake', [.32, .48, .56], 'none', 'none', 'water'],
  electric: ['arc', [.38, .62, 1], 'arc', 'none', 'electrical'],
  flame:     ['flame', [1, .16, .018], 'flame', 'soot', 'burn'],
  melee:     ['none', [0, 0, 0], 'none', 'none', 'none'],
  heal:      ['none', [0, 0, 0], 'none', 'none', 'none'],
  utility:   ['none', [0, 0, 0], 'none', 'none', 'none'],
  unknown:   ['none', [0, 0, 0], 'none', 'none', 'none'],
}

// Exact authoritative names are integration keys, not player-facing labels.
// family, tracer width, fade lifetime, muzzle scale, optional presentation overrides.
// Sizes are chosen per named weapon role; damage is deliberately absent from authoring.
const AUTHORED = {
  Pistol: ['bullet', .012, .045, .07],
  Colt45: ['bullet', .018, .055, .1],
  SilencedPPK: ['bullet', .009, .03, 0, { muzzle: 'none', smoke: 'none' }],
  M1Carbine: ['bullet', .016, .065, .12],
  M60mg: ['mg', .021, .075, .16],
  Vulcan: ['mg', .027, .055, .2],
  ChainGun: ['mg', .032, .085, .24],
  'ChainGun.Yak': ['mg', .035, .095, .26],
  'ZSU-23': ['mg', .037, .065, .28],
  'FLAK-23-AA': ['cannon', .038, .085, .3, { impact: 'flak' }],
  'FLAK-23-AG': ['cannon', .041, .09, .32],
  '25mm': ['cannon', .045, .095, .34],
  '2Inch': ['cannon', .058, .11, .42],
  '90mm': ['cannon', .08, .13, .6],
  '105mm': ['cannon', .092, .145, .7],
  '120mm': ['cannon', .105, .16, .8],
  TurretGun: ['cannon', .088, .15, .72],
  '155mm': ['artillery', .13, .2, 1],
  '8Inch': ['artillery', .16, .24, 1.25],
  Grenade: ['artillery', 0, 0, 0, { tracer: 'none', muzzle: 'none', smoke: 'none', impact: 'blast' }],
  ParaBomb: ['artillery', 0, 0, 0, { tracer: 'none', muzzle: 'none', smoke: 'none' }],
  DepthCharge: ['artillery', 0, 0, 0, { tracer: 'none', muzzle: 'none', smoke: 'none', impact: 'water' }],
  Dragon: ['rocket', .026, .15, .10],
  RedEye: ['rocket', .022, .14, .08],
  Stinger: ['rocket', .075, .23, .3],
  StingerAA: ['rocket', .06, .19, .26],
  APTusk: ['rocket', .09, .25, .36],
  'APTusk.stnk': ['rocket', .085, .22, .33],
  MammothTusk: ['rocket', .1, .27, .4],
  HellfireAA: ['rocket', .07, .2, .28],
  HellfireAG: ['rocket', .085, .24, .34],
  Maverick: ['rocket', .12, .29, .46],
  Nike: ['rocket', .095, .26, .38],
  SubMissile: ['rocket', .15, .34, .52],
  SubMissileAA: ['rocket', .08, .23, .3],
  SCUD: ['rocket', .18, .38, .65],
  TorpTube: ['torpedo', .12, .35, 0],
  PortaTesla: ['electric', .055, .09, .16],
  TTankZap: ['electric', .09, .12, .26],
  TeslaZap: ['electric', .13, .15, .36],
  Flamer: ['flame', .16, .18, .22],
  AntFireball: ['flame', .22, .23, .28],
  FireballLauncher: ['flame', .3, .28, .4],
  DogJaw: ['melee', 0, 0, 0],
  claw: ['melee', 0, 0, 0],
  mandible: ['melee', 0, 0, 0],
  MandibleHeavy: ['melee', 0, 0, 0],
  Heal: ['heal', 0, 0, 0],
  Repair: ['heal', 0, 0, 0],
  DemoTruckTargeting: ['utility', 0, 0, 0],
}

// Matches Armament.cs StableId: case-sensitive UTF-16 code units, uint32 wrap.
export function stableWeaponClass(weapon) {
  let hash = 2166136261
  for (let i = 0; i < weapon.length; i++) hash = Math.imul(hash ^ weapon.charCodeAt(i), 16777619) >>> 0
  return hash % 255 + 1
}

// Armament.cs takes the first DamageWarhead, abs as int64, then clamps to ushort.
// Metadata's damage is that raw first warhead value. This is an ABI discriminator,
// not physical calibre, damage after modifiers, visual size, or explosive yield.
export function presentationCaliber(damage) {
  if (!Number.isInteger(damage) || damage < -2147483648 || damage > 2147483647)
    throw new Error(`Invalid authoritative damage: ${damage}`)
  return Math.min(Math.abs(damage), 65535)
}

export function authorStyle(weapon) {
  const [family, widthM, lifetimeSeconds, scaleM, overrides = {}] = Object.hasOwn(AUTHORED, weapon) ? AUTHORED[weapon] : ['unknown', 0, 0, 0]
  const [tracer, color, muzzle, smoke, impact] = FAMILIES[family]
  const style = {
    family,
    tracer: { style: overrides.tracer ?? tracer, colorLinearRGB: [...color], widthM, lifetimeSeconds },
    muzzle: { style: overrides.muzzle ?? muzzle, scaleM },
    smoke: overrides.smoke ?? smoke,
    impact: overrides.impact ?? impact,
  }
  if(['rocket','torpedo'].includes(family)||['ParaBomb','DepthCharge','Grenade'].includes(weapon)) {
    const shoulder=['Dragon','RedEye'].includes(weapon)
    // Dimensions calibrated against the saved launch tubes and mounted missile bodies.
    const dimensions={Dragon:[.112,.010],RedEye:[.112,.010],MammothTusk:[.23,.020],APTusk:[.23,.018],
      'APTusk.stnk':[.23,.018],HellfireAG:[.40,.020],HellfireAA:[.40,.020],Maverick:[.56,.024],
      Nike:[.46,.048],SCUD:[1.06,.055],TorpTube:[.46,.033],Grenade:[.045,.012]}[weapon]
    const heavy=['SCUD','SubMissile'].includes(weapon),water=family==='torpedo'||weapon==='DepthCharge',drop=['ParaBomb','DepthCharge','Grenade'].includes(weapon)
    style.projectile={body:weapon==='Grenade'?'grenade':family==='torpedo'?'torpedo':weapon==='DepthCharge'?'depth-charge':drop?'bomb':heavy?'heavy-rocket':'missile',
      material:heavy||drop?'olive':family==='torpedo'||['MammothTusk','APTusk','APTusk.stnk'].includes(weapon)?'light-grey':'off-white',
      lengthM:dimensions?.[0]??(heavy?.75:drop?.32:family==='torpedo'?.46:.28),radiusM:dimensions?.[1]??(heavy?.052:drop?.038:.025),exhaust:!water&&!drop,
      trail:{widthM:shoulder?.026:heavy?.11:.065,lifetimeS:heavy?2:water?1.1:1.5,colorLinearRGB:water?[.42,.67,.68]:heavy?[.48,.50,.48]:[.72,.74,.76],opacity:water?.28:.42,turbulence:water?.012:heavy?.030:.016}}
  }
  return style
}

export function assertCompatibleProfiles(profiles) {
  if (profiles.length > MAX_PROFILES) throw new Error(`Weapon profile budget exceeded: ${profiles.length}`)
  const seen = new Map()
  for (const profile of profiles) {
    if (!Number.isInteger(profile.weaponClass) || profile.weaponClass < 1 || profile.weaponClass > 255 ||
        !Number.isInteger(profile.caliber) || profile.caliber < 0 || profile.caliber > 65535)
      throw new Error(`Invalid weapon binding: ${profile.weapon}`)
    const key = profile.weaponClass * 65536 + profile.caliber
    const previous = seen.get(key)
    if (previous && JSON.stringify(previous.style) !== JSON.stringify(profile.style))
      throw new Error(`Conflicting weapon visual collision: ${previous.weapon} / ${profile.weapon} (${profile.weaponClass}, ${profile.caliber})`)
    seen.set(key, profile)
  }
}

export function forgeWeaponVisuals(sourceText = readFileSync(SOURCE_URL, 'utf8')) {
  const metadata = JSON.parse(sourceText)
  if (metadata.schemaVersion !== 2 || !metadata.actors || typeof metadata.actors !== 'object')
    throw new Error('Expected visual metadata schema 2 with actors')
  const catalog = new Map()
  for (const actor of Object.keys(metadata.actors).sort(compare)) {
    const slot = metadata.actors[actor].slot
    if (!slot) continue
    if (!Array.isArray(slot.armaments)) throw new Error(`Missing slot armaments: ${actor}`)
    for (const [index, arm] of slot.armaments.entries()) {
      if (typeof arm.weapon !== 'string' || !arm.weapon || typeof arm.projectile !== 'string')
        throw new Error(`Invalid armament metadata: ${actor}/${index}`)
      const caliber = presentationCaliber(arm.damage)
      let entry = catalog.get(arm.weapon)
      if (entry && (entry.damage !== arm.damage || entry.projectile !== arm.projectile))
        throw new Error(`Inconsistent weapon metadata: ${arm.weapon}`)
      if (!entry) {
        entry = { weapon: arm.weapon, damage: arm.damage, caliber, projectile: arm.projectile, refs: [] }
        catalog.set(arm.weapon, entry)
      }
      entry.refs.push({ actor, armamentIndex: index })
    }
  }
  if (!catalog.size) throw new Error('Empty weapon catalog')
  const profiles = [...catalog.values()].sort((a, b) => compare(a.weapon, b.weapon)).map(entry => ({
    weapon: entry.weapon,
    weaponClass: stableWeaponClass(entry.weapon),
    caliber: entry.caliber,
    projectileClass: entry.projectile,
    style: authorStyle(entry.weapon),
    provenance: {
      authoring: { kind: 'original', source: AUTHORING_PATH, revision: 1, key: Object.hasOwn(AUTHORED, entry.weapon) ? entry.weapon : 'unknown' },
      authoritative: { source: SOURCE_PATH, path: 'actors[actor].slot.armaments[armamentIndex]', damage: entry.damage, refs: entry.refs },
    },
  }))
  assertCompatibleProfiles(profiles)
  return {
    schemaVersion: 1,
    source: { path: SOURCE_PATH, sha256: sha256(sourceText), commit: metadata.sourceCommit },
    authoring: { source: AUTHORING_PATH, revision: 1, sha256: sha256(JSON.stringify({ FAMILIES, AUTHORED, authorStyle: authorStyle.toString() })) },
    semantics: {
      colors: 'All material colors are authored linear RGB, not sRGB; intensity/exposure belongs to the consumer.',
      sizes: 'Artistic world-metre envelopes per named weapon role; neither raw damage nor ABI caliber is a physical bore measurement.',
      lifetime: 'Visual fade/persistence seconds only, not projectile flight time or hit timing.',
      binding: 'Armament.cs StableId(info.Weapon): FNV32 over UTF-16, modulo 255 + 1; caliber: abs(first DamageWarhead.Damage) clamped to 65535.',
      integration: 'Foundation only. No renderer consumer or Bullet/Missile observer route supplied. Require authoritative events/positions; never infer flight from these profiles.',
    },
    maxProfiles: MAX_PROFILES,
    profileCount: profiles.length,
    fallback: authorStyle(''),
    profiles,
  }
}

export const serializeManifest = manifest => JSON.stringify(manifest, null, 2) + '\n'

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some(arg => !['--check', '--stdout'].includes(arg)))
    throw new Error('Usage: weaponvisual-forge.mjs [--check|--stdout]')
  const manifest = forgeWeaponVisuals()
  const text = serializeManifest(manifest)
  if (args.includes('--stdout')) process.stdout.write(text)
  else if (args.includes('--check')) {
    if (readFileSync(OUTPUT_URL, 'utf8') !== text) throw new Error('Stale weapon visual manifest; rerun weaponvisual-forge.mjs')
    console.log(`weaponvisual-forge: PASS — ${manifest.profileCount} profiles, deterministic output current`)
  } else {
    writeFileSync(OUTPUT_URL, text)
    console.log(`weaponvisual-forge: wrote ${manifest.profileCount} profiles to ${fileURLToPath(OUTPUT_URL)}`)
  }
}
