#!/usr/bin/env node
// Protect the player-facing production/economy loop without reimplementing OpenRA rules.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TOOL = 'productionuxgate'
const webRoot = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(webRoot, 'src/core/ra-visual-manifest.json'), 'utf8'))
const ui = readFileSync(resolve(webRoot, 'src/ui/index.ts'), 'utf8')
const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')
const emitter = readFileSync(resolve(webRoot, '../engine/steelseed-host/OpenRA.Browser/SnapshotEmitter.cs'), 'utf8')
const actors = manifest.actors ?? {}

const failures = []
const fail = message => failures.push(message)
const expectedNames = {
	fact: 'Construction Yard',
	proc: 'Ore Refinery',
	weap: 'War Factory',
	tent: 'Allied Barracks',
	barr: 'Soviet Barracks',
	harv: 'Ore Truck',
	'2tnk': 'Medium Tank',
	'3tnk': 'Heavy Tank',
	mcv: 'Mobile Construction Vehicle',
}

for (const [actorName, expected] of Object.entries(expectedNames))
	if (actors[actorName]?.displayName !== expected)
		fail(`${actorName} display name is '${actors[actorName]?.displayName ?? 'missing'}', expected '${expected}'`)

for (const [actorName, actor] of Object.entries(actors))
	if (actor.renderable && (typeof actor.displayName !== 'string' || actor.displayName.trim().length === 0))
		fail(`${actorName} is renderable but has no resolved display name`)

const producerKinds = {
	fact: 0,
	tent: 1,
	barr: 1,
	weap: 2,
	afld: 3,
	hpad: 3,
	syrd: 4,
	spen: 4,
}
const kindFor = actor => {
	const types = actor?.production?.types ?? []
	if (types.some(type => /Building|Defense/i.test(type))) return 0
	if (types.some(type => /Infantry|Soldier/i.test(type))) return 1
	if (types.some(type => /Vehicle/i.test(type))) return 2
	if (types.some(type => /Aircraft|Plane|Helicopter/i.test(type))) return 3
	if (types.some(type => /Ship|Boat|Submarine|Naval/i.test(type))) return 4
	return -1
}
for (const [actorName, expected] of Object.entries(producerKinds))
	if (kindFor(actors[actorName]) !== expected)
		fail(`${actorName} no longer resolves to production queue kind ${expected}`)

const freeActor = actors.proc?.traits?.find(trait => trait.Name === 'FreeActor')
if (freeActor?.Fields?.Actor?.toLowerCase() !== 'harv')
	fail('Ore Refinery no longer exposes its resolved FreeActor: HARV trait')
const harvester = actors.harv?.traits?.find(trait => trait.Name === 'Harvester')
if (!harvester || harvester.Fields.SearchOnCreation !== 'True' || !/Ore/.test(harvester.Fields.Resources ?? ''))
	fail('Ore Truck no longer exposes automatic ore-searching Harvester semantics')

const uiWitnesses = [
	['resolved names', 'units.displayName(actorName)'],
	['selected producer mapping', 'private selectedProducer(ctx: Ctx)'],
	['selected queue filtering', 'dom.root.hidden = producer !== null && queue.kind !== producer.kind'],
	['real model pick radius', 'units.selectionRadiusM(actors.typeId[i])'],
	['exact visible model placement for picking', 'units.captureActorVisual(actors.id[index], PICK_TRANSFORM, 0, PICK_VISUAL)'],
	['harvester role counter', "units.semanticRole(actorName) !== 'harvester'"],
	['authoritative movement status', 'ActorFlag.moving'],
	['refinery free-truck explanation', 'construction delivers one Ore Truck automatically'],
	['structure-only construction-complete voice', 'wasReady && building && queue.playerId'],
	['unit ready voice at spawn, structures skipped', "if (visual?.visualFamily === 'structure') return"],
]
for (const [label, witness] of uiWitnesses)
	if (!ui.includes(witness)) fail(`UI lost ${label} witness`)

for (const id of ['hud-production-title', 'hud-harvesters', 'hud-water-status'])
	if (!html.includes(`id="${id}"`)) fail(`HUD is missing #${id}`)

for (const queueType of ['Defense', 'Soldier', 'Plane', 'Helicopter', 'Ship', 'Boat', 'Submarine'])
	if (!emitter.includes(`\"${queueType}\"`)) fail(`snapshot host does not classify OpenRA ${queueType} queues`)

if (failures.length > 0) {
	for (const failure of failures) console.error(`  ${failure}`)
	console.error(`${TOOL}: FAIL — production/economy presentation drifted`)
	process.exit(1)
}

console.log(`${TOOL}: PASS — resolved names, eight producer roles, building focus, Ore Truck economy and map-water status are wired`)
