#!/usr/bin/env node

// Build a non-distributable parity witness from the pinned RA rule source. This keeps the
// unstripped actor rule graph and swaps only the minimum headless presentation hooks required
// to run without EA media or OpenRA chrome. The production mod is built by build-ra-mod.mjs.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const TOOL = 'ra-reference'
const hostRoot = resolve(import.meta.dirname, '..')
const engineRoot = resolve(hostRoot, '..')
const sourceRoot = resolve(engineRoot, 'openra/mods/ra')
const assetlessRoot = resolve(hostRoot, 'generated/mods/ra')
const outputRoot = resolve(hostRoot, 'generated/mods/ra-reference')
const policy = JSON.parse(readFileSync(resolve(hostRoot, 'assetless-policy.json'), 'utf8'))
const removedHeadlessTraits = new Set([
	'CellTriggerOverlay',
	'ChronoVortexRenderer',
	'CustomTerrainDebugOverlay',
	'HierarchicalPathFinderOverlay',
	'LoadWidgetAtGameStart',
	'PathFinderOverlay',
	'RenderDebugState',
	'StartGameNotification',
	'TerrainRenderer',
])

function fail(message) {
	throw new Error(`${TOOL}: ${message}`)
}

function ensureParent(path) {
	mkdirSync(dirname(path), { recursive: true })
}

function copyExact(source, target) {
	if (!existsSync(source)) fail(`missing input ${source}`)
	ensureParent(target)
	copyFileSync(source, target)
}

function writeExact(path, value) {
	ensureParent(path)
	writeFileSync(path, value)
}

function indentOf(line) {
	let indent = 0
	while (indent < line.length && line.charCodeAt(indent) === 9) indent++
	return indent
}

function nodeOf(line) {
	const indent = indentOf(line)
	const content = line.slice(indent)
	if (!content || content.startsWith('#')) return null
	const colon = content.indexOf(':')
	if (colon < 0) return null
	return { indent, key: content.slice(0, colon).trim(), value: content.slice(colon + 1).trim() }
}

function baseTrait(key) {
	let value = key.startsWith('-') ? key.slice(1) : key
	const suffix = value.indexOf('@')
	if (suffix >= 0) value = value.slice(0, suffix)
	return value
}

function transformReferenceRules(text, label, counts) {
	const output = []
	let skippingIndent = -1
	for (const line of text.split('\n')) {
		const node = nodeOf(line)
		if (skippingIndent >= 0) {
			if (node == null || node.indent > skippingIndent) continue
			skippingIndent = -1
		}

		if (node?.indent === 1 && node.key === 'Inherits' && node.value === '^Palettes') {
			output.push('\tInherits: ^AssetlessPalettes')
			counts.paletteInheritance++
			continue
		}

		if (node?.indent === 1 && removedHeadlessTraits.has(baseTrait(node.key))) {
			const trait = baseTrait(node.key)
			counts.removedTraits[trait] = (counts.removedTraits[trait] ?? 0) + 1
			skippingIndent = node.indent
			continue
		}

		output.push(line)
	}

	let result = output.join('\n')
	while (result.endsWith('\n')) result = result.slice(0, -1)
	result += '\n'
	for (const line of result.split('\n')) {
		const node = nodeOf(line)
		if (node?.indent === 1 && removedHeadlessTraits.has(baseTrait(node.key)))
			fail(`${label} retained headless blocker ${node.key}`)
		if (node?.indent === 1 && node.key === 'Inherits' && node.value === '^Palettes')
			fail(`${label} retained file-backed palette inheritance`)
	}
	return result
}

function copyNamed(folder, names, sourceBase = sourceRoot) {
	for (const name of names) copyExact(resolve(sourceBase, folder, name), resolve(outputRoot, folder, name))
}

if (!existsSync(assetlessRoot)) fail('assetless mod must be generated first')
if (existsSync(outputRoot)) rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })

const counts = { paletteInheritance: 0, removedTraits: {} }
for (const name of policy.rules) {
	const source = resolve(sourceRoot, 'rules', name)
	writeExact(resolve(outputRoot, 'rules', name),
		transformReferenceRules(readFileSync(source, 'utf8'), `rules/${name}`, counts))
}
if (counts.paletteInheritance !== 1) fail(`expected one ^Palettes inheritance replacement, found ${counts.paletteInheritance}`)
for (const trait of removedHeadlessTraits)
	if (!counts.removedTraits[trait]) fail(`headless presentation blocker ${trait} was not found upstream`)

copyNamed('weapons', policy.weapons)
copyNamed('tilesets', policy.tilesets)
// Assetless sequence metadata preserves the gameplay-sensitive witnessed make timings while
// avoiding file-sized wildcards. It is shared byte-for-byte by both parity participants.
copyNamed('sequences', policy.sequences, assetlessRoot)

for (const mapId of readdirSync(resolve(sourceRoot, 'maps')).sort()) {
	copyExact(resolve(sourceRoot, 'maps', mapId, 'map.yaml'), resolve(outputRoot, 'maps', mapId, 'map.yaml'))
	copyExact(resolve(sourceRoot, 'maps', mapId, 'map.bin'), resolve(outputRoot, 'maps', mapId, 'map.bin'))
}

const manifest = readFileSync(resolve(hostRoot, 'mod/mod.yaml'), 'utf8').split('\n').map(line => {
	if (line === '\tTitle: Red Alert — STEELSEED presentation') return '\tTitle: Red Alert — parity reference'
	if (line === '\tVersion: 7eabcfe-assetless-v1') return '\tVersion: 7eabcfe-parity-reference-v1'
	if (line === '\t\t$ra: ra') return '\t\t$ra-reference: ra'
	return line
}).join('\n')
writeExact(resolve(outputRoot, 'mod.yaml'), manifest)
for (const name of ['cursors.yaml', 'metrics.yaml', 'notifications.yaml', 'assetless'])
	copyExact(resolve(hostRoot, 'mod', name), resolve(outputRoot, name))
const referencePresentation = readFileSync(resolve(hostRoot, 'mod/assetless-presentation.yaml'), 'utf8')
	.split('\n')
	.filter(line => line !== '\tInherits@ASSETLESS: ^AssetlessPalettes' && line !== '\tAssetlessResourceRenderer:')
	.join('\n')
writeExact(resolve(outputRoot, 'rules/assetless-presentation.yaml'), referencePresentation)
copyExact(resolve(hostRoot, 'mod/deployment-rules.yaml'), resolve(outputRoot, 'rules/deployment-rules.yaml'))
copyExact(resolve(sourceRoot, 'fluent/ra.ftl'), resolve(outputRoot, 'fluent/ra.ftl'))
copyExact(resolve(sourceRoot, 'fluent/rules.ftl'), resolve(outputRoot, 'fluent/rules.ftl'))
copyExact(resolve(hostRoot, 'mod/host.ftl'), resolve(outputRoot, 'fluent/host.ftl'))

writeExact(resolve(hostRoot, 'generated/reference-report.json'), `${JSON.stringify({
	schemaVersion: 1,
	sourceCommit: policy.sourceCommit,
	mapCount: readdirSync(resolve(outputRoot, 'maps')).length,
	ruleFiles: policy.rules.length,
	sequenceAdapter: 'byte-identical-to-assetless-witnessed-timings',
	paletteAdapter: '^Palettes -> ^AssetlessPalettes',
	removedHeadlessPresentationTraits: counts.removedTraits,
}, null, '\t')}\n`)

console.log(`${TOOL}: PASS — pinned unstripped RA rule source, ${policy.rules.length} rule files, ${readdirSync(resolve(outputRoot, 'maps')).length} maps; only palette adapter and ${[...removedHeadlessTraits].join('/')} headless traits differ`)
