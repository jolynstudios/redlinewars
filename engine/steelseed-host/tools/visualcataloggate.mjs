#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fail } from './gate-lib.mjs'

const TOOL = 'visualcataloggate'
const gameRoot = resolve(import.meta.dirname, '../../..')
const manifest = JSON.parse(readFileSync(resolve(gameRoot, 'web/src/core/ra-visual-manifest.json'), 'utf8'))
const audit = JSON.parse(readFileSync(resolve(import.meta.dirname, '../generated/ra-trait-audit.json'), 'utf8'))
const policy = JSON.parse(readFileSync(resolve(import.meta.dirname, '../trait-audit-policy.json'), 'utf8'))
const source = JSON.parse(readFileSync(resolve(import.meta.dirname, '../generated/ra-visual-source.json'), 'utf8'))
const actors = Object.entries(manifest.actors ?? {})

if (manifest.schemaVersion !== 2) fail(TOOL, `manifest ABI is ${manifest.schemaVersion}, expected 2`)
const sourceNames = Object.keys(source.actors).sort()
const names = actors.map(([name]) => name).sort()
if (JSON.stringify(names) !== JSON.stringify(sourceNames) || manifest.actorCount !== names.length)
	fail(TOOL, 'catalog does not cover the resolved source roster exactly')
if (audit.schemaVersion !== 1 || audit.actorCount !== names.length ||
	JSON.stringify(Object.keys(audit.actors ?? {}).sort()) !== JSON.stringify(names))
	fail(TOOL, 'resolved trait audit does not cover the catalog exactly')
if (Object.keys(policy.traits ?? {}).length !== audit.traitCount) fail(TOOL, 'trait policy and resolved audit drifted')

const descriptorHashes = new Map()
let renderable = 0
let system = 0
let auditedTraits = 0
for (const [name, actor] of actors) {
	if (typeof actor.displayName !== 'string' || actor.displayName.trim().length === 0)
		fail(TOOL, `${name} has no resolved OpenRA display name`)
	const actorAudit = audit.actors?.[name]
	if (!Array.isArray(actorAudit) || actorAudit.length !== actor.traits?.length)
		fail(TOOL, `${name} is not audited one-for-one against its resolved traits`)
	for (const trait of actorAudit) {
		auditedTraits++
		if (!['procedural-shape-animation', 'simulation-only', 'removed-presentation'].includes(trait.classification))
			fail(TOOL, `${name}.${trait.trait} has unknown classification '${trait.classification}'`)
		if (policy.traits[trait.trait] !== trait.classification)
			fail(TOOL, `${name}.${trait.trait} classification differs from policy`)
	}
	if (!actor.renderable) {
		system++
		if (actor.role !== 'system' || actor.slot !== null)
			fail(TOOL, `${name} is non-renderable but not explicitly classified as a slotless system actor`)
		continue
	}
	renderable++
	if (!actor.slot || actor.slot.name !== name)
		fail(TOOL, `${name} has no actor-specific procedural descriptor`)
	if (!actor.meshSeed || !actor.descriptorHash) fail(TOOL, `${name} lacks deterministic identity metadata`)
	if (descriptorHashes.has(actor.descriptorHash))
		fail(TOOL, `${name} shares descriptor hash with ${descriptorHashes.get(actor.descriptorHash)}`)
	descriptorHashes.set(actor.descriptorHash, name)
	if ('fallback' in actor || 'fallbackSlot' in actor)
		fail(TOOL, `${name} still exposes the removed generic-family fallback contract`)
}

if (renderable !== manifest.renderableCount || renderable + system !== sourceNames.length)
	fail(TOOL, `classification is ${renderable} renderable/${system} system; inconsistent with catalog metadata`)

console.log(`${TOOL}: PASS — ${actors.length}/${sourceNames.length} actors audited (${auditedTraits} resolved trait instances), ` +
	`${renderable} actor-specific procedural descriptors, ${system} explicit non-renderable system actors, zero family fallbacks`)
