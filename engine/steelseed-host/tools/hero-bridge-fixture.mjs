// Test-only actor placement on a copy of the canonical River Crossing map.
// Installed in the WASM VFS by runtime-fixture; never generated into AppBundle.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bootRuntime } from './runtime-fixture.mjs'

export const BRIDGE_FIXTURE_TITLE = 'River Crossing — bridge gate fixture'
export async function bootHeroBridgeFixture() {
 const source = new URL('../generated/mods/ra/maps/planx-river-crossing/', import.meta.url)
 const yaml = readFileSync(new URL('map.yaml', source), 'utf8')
 assert.doesNotMatch(yaml, /Owner: Multi\d+/, 'public River Crossing must not contain player-owned test actors')
 const fixtureYaml = yaml.replace('Title: River Crossing — STEELSEED', `Title: ${BRIDGE_FIXTURE_TITLE}`) +
  `\tBridgePatrolFoot: e1\n\t\tOwner: Multi0\n\t\tLocation: 25,22\n\tBridgePatrolWheeled: jeep\n\t\tOwner: Multi0\n\t\tLocation: 25,24\n\tBridgeEngineer: e6\n\t\tOwner: Multi0\n\t\tLocation: 24,26\n\tBridgePatrolTracked: 2tnk\n\t\tOwner: Multi0\n\t\tLocation: 24,23\n`
 const prefix = '/openra/engine/mods/ra/maps/gate-hero-bridge/'
 return bootRuntime({fixtureFiles: [
  [prefix + 'map.yaml', Buffer.from(fixtureYaml)],
  [prefix + 'map.bin', readFileSync(new URL('map.bin', source))],
 ]})
}
