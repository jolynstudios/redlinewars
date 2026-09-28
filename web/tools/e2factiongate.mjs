#!/usr/bin/env node
// Jackson is a distinct Allied hero; E2 stays a white grenadier.
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
	actorTypeName: typeId => ({ 1: 'e2', 2: 'e3', 3:'jackson' })[typeId],
	get: () => ({ displayName: name => ({ e2: 'Grenadier', e3: 'Rifle Infantry' })[name] }),
}
assert.equal(display(ctx, 1, 'england'), 'Grenadier')
assert.equal(display(ctx, 1, 'france'), 'Grenadier')
assert.equal(display(ctx, 1, 'germany'), 'Grenadier')
assert.equal(display(ctx, 1, 'russia'), 'Grenadier')
assert.equal(display(ctx, 1, 'ukraine'), 'Grenadier')
assert.equal(display(ctx, 2, 'russia'), 'Rifle Infantry')
assert.equal(display(ctx, 3, 'england'), 'Jackson')
assert.ok(uiSource.includes('this.localFactionId = config.local.faction'), 'local skirmish faction is not captured')
assert.ok(uiSource.includes('this.localFactionId = faction'), 'multiplayer faction is not captured')

for (const token of [
	"const E2_SOVIET_MATERIAL = 'planx-troop-e2.soviet-v1'",
	'cloneE2SovietBuckets()',
	"drawnSlot = drawnSlot === 'e2' ? 'e2.soviet' : drawnSlot.replace(/^e2(?=\\.)/, 'e2.soviet')",
]) assert.ok(unitsSource.includes(token), `white E2 presentation missing: ${token}`)

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
assert.ok(maps.some(map => map.sourcesContent.some(source => source.includes("actorName === 'jackson'"))), 'explicit Jackson HUD identity is absent from production source maps')

const catalogue = JSON.parse(read('landing/src/data/catalogue.json'))
const jackson = catalogue.find(entry => entry.id === 'jackson')
const grenadier = catalogue.find(entry => entry.id === 'e2')
assert.equal(jackson.name, 'Jackson')
assert.equal(jackson.faction, 'Allies')
assert.deepEqual(jackson.countries, ['England','France','Germany'])
assert.equal(grenadier.name, 'Grenadier')
assert.equal(grenadier.faction, 'Soviets')
const hero=JSON.parse(read('web/.forge/troop-jackson/manifest.json'))
assert.deepEqual(hero.slots,['jackson'])
assert.equal(jackson.sourceSha256,hero.parentSourceSha256)
assert.equal(sha(read(hero.parentSourcePath)),hero.parentSourceSha256)
const rules=read('engine/steelseed-host/mod/joa-rules.yaml').toString()
assert.match(rules,/Prerequisites: ~tent, ~infantry\.allies, ~techlevel\.infonly/)
assert.match(rules,/BuildLimit: 1/)
assert.match(rules,/HP: 5000/)
assert.match(rules,/Cost: 700/)
const actors=JSON.parse(read('web/src/core/ra-visual-manifest.json')).actors;assert.equal(actors.jackson.traits.some(t=>t.Name==='ChangesHealth'),false);assert.match(actors.jackson.traits.find(t=>t.Name==='AttackFrontal').Fields.Armaments,/air/);assert.equal(actors.jackson.health.HP,actors.e7.health.HP/2)
console.log('e2factiongate: PASS distinct Allied Jackson, white grenadier, authored hero, HUD and shipped atlas')
