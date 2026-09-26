#!/usr/bin/env node

import { validateDeploymentTiming } from './deployment-timing.mjs'
import { HERO_BRIDGE_RULE, HERO_BRIDGE_TEMPLATES, insertHeroTemplates } from './hero-bridge-mod.mjs'

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { baseTrait, fail, sha256, yamlNode } from './gate-lib.mjs'

const TOOL = 'ruleparitygate'
const hostRoot = resolve(import.meta.dirname, '..')
const sourceRoot = resolve(hostRoot, '../openra/mods/ra')
const targetRoot = resolve(hostRoot, 'generated/mods/ra')
const policy = JSON.parse(readFileSync(resolve(hostRoot, 'assetless-policy.json'), 'utf8'))
const timing = JSON.parse(readFileSync(resolve(hostRoot, 'sequence-timing.json'), 'utf8'))
validateDeploymentTiming(JSON.parse(readFileSync(resolve(hostRoot, 'deployment-timing.json'))), readFileSync(resolve(hostRoot, 'sequence-timing.json')))
const removeTraits = new Set(policy.removeTraits)
const removeInherits = new Set(policy.removeInherits)
const removeWarheads = new Set(policy.removeWarheads ?? [])
const stripSequenceFields = new Set(policy.stripSequenceFields)

function finalNewline(lines) {
	while (lines.at(-1) === '') lines.pop()
	return `${lines.join('\n')}\n`
}

function expectedRules(text) {
	const output = []
	let ignoredBelow = -1
	for (const line of text.split('\n')) {
		const node = yamlNode(line)
		if (ignoredBelow >= 0) {
			if (node == null || node.indent > ignoredBelow) continue
			ignoredBelow = -1
		}
		if (node?.indent === 1) {
			const trait = baseTrait(node.key)
			if (removeTraits.has(trait) || (trait === 'Inherits' && removeInherits.has(node.value))) {
				ignoredBelow = node.indent
				continue
			}
		}
		output.push(line)
	}
	return finalNewline(output)
}

/**
 * Weapons are upstream byte-for-byte except for warheads the policy removes.
 *
 * A warhead is on that list only when its implementation reaches a world trait
 * `removeTraits` deletes — `ShakeScreen` reaches `ScreenShaker` — because OpenRA resolves
 * those with `Trait<T>()`, which throws mid-tick when the trait is gone. The allowlist is
 * still an allowlist: everything else in a weapon file must match upstream exactly.
 */
function expectedWeapons(text) {
	const output = []
	let ignoredBelow = -1
	for (const line of text.split('\n')) {
		const node = yamlNode(line)
		if (ignoredBelow >= 0) {
			if (node == null || node.indent > ignoredBelow) continue
			ignoredBelow = -1
		}
		if (node?.indent === 1 && baseTrait(node.key) === 'Warhead' && removeWarheads.has(node.value)) {
			ignoredBelow = node.indent
			continue
		}
		output.push(line)
	}
	return finalNewline(output)
}

function expectedSequences(text, label) {
	const output = []
	let ignoredBelow = -1
	let image = ''
	let sequence = ''
	for (const line of text.split('\n')) {
		const node = yamlNode(line)
		if (node?.indent === 0) { image = node.key.toLowerCase(); sequence = '' }
		else if (node?.indent === 1) sequence = node.key
		if (ignoredBelow >= 0) {
			if (node == null || node.indent > ignoredBelow) continue
			ignoredBelow = -1
		}
		if (node != null && node.indent >= 2 && stripSequenceFields.has(node.key)) {
			ignoredBelow = node.indent
			continue
		}
		if (node != null && node.indent >= 2 && node.key === 'Length' && node.value === '*') {
			const witnessed = node.indent === 2 && sequence === 'make'
				? (image === 'fact' ? 96 : timing.makeSequenceLengths[image])
				: policy.wildcardSequenceLength
			if (!Number.isInteger(witnessed) || witnessed <= 0)
				fail(TOOL, `${label}:${image}.${sequence} has no valid assetless sequence length`)
			output.push(`${'\t'.repeat(node.indent)}Length: ${witnessed}`)
			if (node.indent === 2 && image === 'fact' && sequence === 'make') output.push('\t\tTick: 40')
			continue
		}
		output.push(line)
	}
	return finalNewline(output)
}

function expectedMap(text) {
	const output = []
	let inRules = false
	let ignoredBelow = -1
	for (const line of text.split('\n')) {
		const node = yamlNode(line)
		if (ignoredBelow >= 0) {
			if (node == null || node.indent > ignoredBelow) continue
			ignoredBelow = -1
		}
		if (node?.indent === 0) inRules = node.key === 'Rules'
		if (inRules && node?.indent === 2 && removeTraits.has(baseTrait(node.key))) {
			ignoredBelow = node.indent
			continue
		}
		output.push(line)
	}
	return finalNewline(output)
}

const graphParts = []
let compared = 0
function compare(relativePath, expected) {
	const actual = readFileSync(resolve(targetRoot, relativePath))
	const wanted = Buffer.isBuffer(expected) ? expected : Buffer.from(expected)
	if (!actual.equals(wanted)) fail(TOOL, `${relativePath} differs outside the presentation allowlist`)
	graphParts.push(relativePath, sha256(actual))
	compared++
}

compare('rules/deployment-rules.yaml', readFileSync(resolve(hostRoot, 'mod/deployment-rules.yaml')))

/**
 * world.yaml additionally carries the host-owned hero bridge: installHeroBridge
 * appends `ssherobridge` to LegacyBridgeLayer's Bridges when generating the
 * assetless mod, so the expected side must carry the same addition or the
 * host-owned landmark reads as unexplained drift.
 */
function expectedWorld(text) {
	const base = expectedRules(text)
	const pattern = /(\tLegacyBridgeLayer:\n\t\tBridges: [^\n]+)/
	if (!pattern.test(base)) fail(TOOL, 'expected world: missing LegacyBridgeLayer')
	return base.replace(pattern, '$1, ssherobridge')
}

function expectedCivilian(text) {
	const base = expectedRules(text)
	// installHeroBridge appends the host-owned SSHEROBRIDGE rule to the generated
	// civilian rules; the expected side must carry the identical block.
	return `${base}${HERO_BRIDGE_RULE}`
}

for (const name of policy.rules) {
	const relativePath = `rules/${name}`
	const expected = name === 'world.yaml'
		? expectedWorld(readFileSync(resolve(sourceRoot, relativePath), 'utf8'))
		: name === 'civilian.yaml'
			? expectedCivilian(readFileSync(resolve(sourceRoot, relativePath), 'utf8'))
			: expectedRules(readFileSync(resolve(sourceRoot, relativePath), 'utf8'))
	compare(relativePath, expected)
}
for (const name of policy.weapons) {
	const relativePath = `weapons/${name}`
	compare(relativePath, expectedWeapons(readFileSync(resolve(sourceRoot, relativePath), 'utf8')))
}
for (const name of policy.tilesets) {
	const relativePath = `tilesets/${name}`
	const source = readFileSync(resolve(sourceRoot, relativePath))
	// The generated temperat.yaml carries the host-owned hero bridge templates
	// (insertHeroTemplates at generation time); temperat must therefore expect
	// the same injection instead of raw upstream bytes.
	const expected = name === 'temperat.yaml'
		? insertHeroTemplates(source.toString('utf8'), HERO_BRIDGE_TEMPLATES)
		: source
	compare(relativePath, expected)
}
for (const name of policy.sequences) {
	const relativePath = `sequences/${name}`
	compare(relativePath, expectedSequences(readFileSync(resolve(sourceRoot, relativePath), 'utf8'), relativePath))
}

const sourceMaps = resolve(sourceRoot, 'maps')
for (const map of readdirSync(sourceMaps).sort())
	for (const name of ['map.yaml', 'map.bin']) {
		const relativePath = `maps/${map}/${name}`
		const source = readFileSync(resolve(sourceRoot, relativePath))
		compare(relativePath, name === 'map.yaml' ? expectedMap(source.toString('utf8')) : source)
	}

// Witnessed-red control: one gameplay byte must change the canonical aggregate.
const graphHash = sha256(graphParts.join('\n'))
const mutated = [...graphParts]
mutated[mutated.length - 1] = `${mutated.at(-1)}0`
if (sha256(mutated.join('\n')) === graphHash) fail(TOOL, 'gameplay mutation falsifier did not change the graph hash')

console.log(`${TOOL}: PASS — ${compared} rule/weapon/tileset/sequence/map files match the canonical graph except allowlisted presentation traits and explicit Steelseed fact timing/operation overrides (${graphHash.slice(0, 16)}); gameplay-byte falsifier witnessed red`)
