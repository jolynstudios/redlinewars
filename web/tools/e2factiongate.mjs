#!/usr/bin/env node
// E2 is one gameplay actor with two presentation identities. This gate pins that contract.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'

const web = resolve(import.meta.dirname, '..')
const root = resolve(web, '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => readFileSync(resolve(root, path))
const uiSource = read('web/src/ui/index.ts', 'utf8')
const unitsSource = read('web/src/units/index.ts', 'utf8')

const functionMatch = /function actorDisplayName\(ctx: Ctx \| null, typeId: number, localFactionId = ''\): string \{[\s\S]*?\n\}/.exec(uiSource)
assert.ok(functionMatch, 'actorDisplayName helper is missing')
const displaySource = functionMatch[0]
	.replace(/\(ctx: Ctx \| null, typeId: number, localFactionId = ''\): string/, '(ctx, typeId, localFactionId)')
	.replace(/ctx\.get<UnitsApi>\('units'\)/, "ctx.get('units')")
const display = new Function(displaySource + '\nreturn actorDisplayName')()
const ctx = {
	actorTypeName: typeId => ({ 1: 'e2', 2: 'e3' })[typeId],
	get: () => ({ displayName: name => ({ e2: 'Grenadier', e3: 'Rifle Infantry' })[name] }),
}
assert.equal(display(ctx, 1, 'england'), 'Jackson')
assert.equal(display(ctx, 1, 'france'), 'Jackson')
assert.equal(display(ctx, 1, 'germany'), 'Jackson')
assert.equal(display(ctx, 1, 'russia'), 'Grenadier')
assert.equal(display(ctx, 1, 'ukraine'), 'Grenadier')
assert.equal(display(ctx, 2, 'russia'), 'Rifle Infantry')
assert.ok(uiSource.includes('this.localFactionId = config.local.faction'), 'local skirmish faction is not captured')
assert.ok(uiSource.includes('this.localFactionId = faction'), 'multiplayer faction is not captured')

for (const token of [
	"const E2_SOVIET_MATERIAL = 'planx-troop-e2.soviet-v1'",
	"const SOVIET_FACTIONS = new Set(['soviet', 'russia', 'ukraine'])",
	'cloneE2SovietBuckets()',
	"drawnSlot = drawnSlot === 'e2' ? 'e2.soviet' : drawnSlot.replace(/^e2(?=\\.)/, 'e2.soviet')",
]) assert.ok(unitsSource.includes(token), `runtime owner-faction routing missing: ${token}`)

const mesh = JSON.parse(read('web/.forge/troop-e2/manifest.json'))
const sovietMesh = JSON.parse(read('web/.forge/troop-e2.soviet/manifest.json'))
const atlas = JSON.parse(read('web/.forge/troop-e2.soviet-surfaces/manifest.json'))
assert.equal(sovietMesh.presentationOnly, true)
assert.equal(sovietMesh.meshSharedWith, 'troop-e2')
assert.deepEqual(sovietMesh.slots, ['e2.soviet'])
assert.equal(atlas.id, 'planx-troop-e2.soviet-v1')
assert.deepEqual(atlas.slots, ['e2'])
assert.equal(atlas.sourceSha256, mesh.parentSourceSha256)
const recipe = '{"dark": 0.88, "light": 1.08, "skin": [0.82, 0.68, 0.56], "variant": "e2.soviet"}'
assert.equal(sha(Buffer.concat([read('art/blender/planx_troops_materials.py'), Buffer.from(recipe)])), atlas.recipeSha256, 'white Soviet atlas recipe changed')
const atlasPayload = gunzipSync(read('web/.forge/troop-e2.soviet-surfaces/surfaces.sspbr.gz'))
assert.equal(sha(atlasPayload), atlas.sha256, 'Soviet atlas payload hash mismatch')

const assets = join(web, 'dist/assets')
assert.ok(existsSync(assets), 'web/dist is absent; run a clean production build')
const atlasHash = sha(read('web/.forge/troop-e2.soviet-surfaces/surfaces.sspbr.gz'))
assert.ok(readdirSync(assets).some(name => sha(readFileSync(join(assets, name))) === atlasHash), 'Soviet atlas is absent from web/dist')
const maps = readdirSync(assets).filter(name => name.endsWith('.js.map')).map(name => JSON.parse(readFileSync(join(assets, name))))
assert.ok(maps.some(map => map.sourcesContent.some(source => source.includes('cloneE2SovietBuckets'))), 'Soviet bucket routing is absent from production source maps')
assert.ok(maps.some(map => map.sourcesContent.some(source => source.includes("actorName === 'e2' && !['russia', 'ukraine']"))), 'HUD name override is absent from production source maps')

const catalogue = JSON.parse(read('landing/src/data/catalogue.json'))
const jackson = catalogue.find(entry => entry.id === 'e2')
const soviet = catalogue.find(entry => entry.id === 'e2-soviet')
assert.equal(jackson.name, 'Jackson')
assert.equal(jackson.faction, 'Allies')
assert.deepEqual(jackson.countries, ['England', 'France', 'Germany'])
assert.equal(soviet.name, 'Grenadier')
assert.equal(soviet.faction, 'Soviets')
assert.deepEqual(soviet.countries, ['Russia', 'Ukraine'])
assert.equal(soviet.sourceSha256, mesh.parentSourceSha256)
assert.notEqual(sha(read('landing/public/art/catalogue/e2-color.webp')), sha(read('landing/public/art/catalogue/e2-soviet-color.webp')), 'Soviet colour render is not distinct')
console.log('e2factiongate: PASS Allied Jackson, Soviet white Grenadier, HUD routing and shipped atlas')
