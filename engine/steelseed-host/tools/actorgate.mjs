#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fail } from './gate-lib.mjs'

const TOOL = 'actorgate'
const gameRoot = resolve(import.meta.dirname, '../../..')
const manifest = JSON.parse(readFileSync(resolve(gameRoot, 'web/src/core/ra-visual-manifest.json'), 'utf8'))
const worldRules = readFileSync(resolve(import.meta.dirname, '../generated/mods/ra/rules/world.yaml'), 'utf8')
const actors = Object.entries(manifest.actors)
const locomotors = new Map()
for (const block of worldRules.split(/(?=^\tLocomotor@)/m).slice(1)) {
	const name = block.match(/^\t\tName:\s*(\S+)/m)?.[1]
	if (!name) continue
	const terrain = new Set([...block.matchAll(/^\t\t\t([^:]+):/gm)].map(match => match[1].trim()))
	locomotors.set(name, terrain)
}

const sourceNames = Object.keys(JSON.parse(readFileSync(resolve(import.meta.dirname, '../generated/ra-visual-source.json'), 'utf8')).actors).sort()
if (manifest.schemaVersion !== 2 ||
	JSON.stringify(actors.map(([name]) => name).sort()) !== JSON.stringify(sourceNames))
	fail(TOOL, 'visual manifest does not cover the resolved source roster exactly')
if (!worldRules.includes('\tActorMap:') || !worldRules.includes('\tPathFinder:') || !worldRules.includes('\tValidateOrder:'))
	fail(TOOL, 'OpenRA occupancy, pathfinder or order validation is absent from the assetless world')

let mobile = 0
let aircraft = 0
let watercraft = 0
let waterStructures = 0
let selectableUnits = 0
let buildings = 0
for (const [name, actor] of actors) {
	if (!Array.isArray(actor.traits) || (actor.renderable && actor.slot?.name !== name))
		fail(TOOL, `${name} has no actor-specific procedural descriptor or resolved trait set`)
	const traits = new Set(actor.traits.map(trait => trait.Name))
	if (traits.has('Building')) {
		buildings++
		if (traits.has('Mobile')) fail(TOOL, `${name} combines Building occupancy with Mobile movement`)
	}
	if (traits.has('Mobile')) {
		mobile++
		if (!actor.locomotor || !locomotors.has(actor.locomotor))
			fail(TOOL, `${name} has Mobile but unresolved locomotor '${actor.locomotor ?? ''}'`)
	}
	if (traits.has('Aircraft')) {
		aircraft++
		if (traits.has('Mobile')) fail(TOOL, `${name} aircraft is incorrectly constrained by a ground/water Mobile locomotor`)
		if (actor.visualFamily !== 'fixedwing' && actor.visualFamily !== 'rotorcraft')
			fail(TOOL, `${name} has Aircraft but visual family ${actor.visualFamily}`)
	}
	if (actor.visualFamily === 'vessel') {
		watercraft++
		if (!traits.has('Mobile') || !['naval', 'lcraft'].includes(actor.locomotor))
			fail(TOOL, `${name} vessel does not use OpenRA naval/lcraft locomotion`)
	}
	if (actor.terrainTypes?.includes('Water')) {
		waterStructures++
		if (!traits.has('Building')) fail(TOOL, `${name} claims Water terrain without Building occupancy`)
	}
	if (actor.role === 'unit' && traits.has('Selectable')) {
		selectableUnits++
		if (![...['Mobile', 'Aircraft', 'Transforms', 'Immobile', 'Husk']].some(trait => traits.has(trait)))
			fail(TOOL, `${name} is a selectable unit with no OpenRA control/position trait`)
	}
}

for (const name of ['ss', 'msub']) {
	const actor = manifest.actors[name]
	if (!actor || actor.locomotor !== 'naval' || !actor.traits.some(trait => trait.Name === 'Cloak'))
		fail(TOOL, `${name} is not a naval OpenRA Cloak submarine`)
}
const mcv = manifest.actors.mcv
if (!mcv || mcv.locomotor !== 'heavywheeled' || !mcv.traits.some(trait => trait.Name === 'Transforms') ||
	!mcv.traits.some(trait => trait.Name === 'BaseBuilding'))
	fail(TOOL, 'MCV deploy/mobility traits are not resolved from OpenRA')
if (locomotors.get('naval')?.size !== 1 || !locomotors.get('naval')?.has('Water'))
	fail(TOOL, 'naval locomotor is not restricted to Water')
if (!locomotors.get('lcraft')?.has('Water') || !locomotors.get('lcraft')?.has('Beach'))
	fail(TOOL, 'landing craft locomotor does not match Water/Beach rules')
for (const [name, terrain] of locomotors)
	if (name !== 'naval' && name !== 'lcraft' && terrain.has('Water'))
		fail(TOOL, `ground locomotor ${name} unexpectedly permits Water`)

console.log(`${TOOL}: PASS — ${actors.length} actors have resolved ABI-v2 descriptors; ${mobile} Mobile actors use ` +
	`${locomotors.size} OpenRA locomotors; ${aircraft} aircraft, ${watercraft} vessels, ${waterStructures} water structures, ` +
	`${buildings} non-mobile Building occupancies, ${selectableUnits} selectable units; ActorMap/PathFinder/ValidateOrder retained`)
