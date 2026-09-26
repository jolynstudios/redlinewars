#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { env as processEnv } from 'node:process'

import { validateDeploymentTiming, effectiveMakeFrames } from './deployment-timing.mjs'

import { installHeroBridge, HERO_BRIDGE_RULE } from './hero-bridge-mod.mjs'

import { computeSimBuild, modTreeHash, MOD_VERSION_TAG } from './sim-build-id.mjs'

const TOOL = 'assetstrip'
const hostRoot = resolve(import.meta.dirname, '..')
const engineRoot = resolve(hostRoot, '..')
const sourceRoot = resolve(engineRoot, 'openra/mods/ra')
const outputRoot = resolve(hostRoot, 'generated/mods/ra')
const policy = JSON.parse(readFileSync(resolve(hostRoot, 'assetless-policy.json'), 'utf8'))
const sequenceTiming = JSON.parse(readFileSync(resolve(hostRoot, 'sequence-timing.json'), 'utf8'))
const deploymentTiming = validateDeploymentTiming(JSON.parse(readFileSync(resolve(hostRoot, 'deployment-timing.json'))), readFileSync(resolve(hostRoot, 'sequence-timing.json')))
const removeTraits = new Set(policy.removeTraits)
const removeInherits = new Set(policy.removeInherits)
const removeWarheads = new Set(policy.removeWarheads ?? [])
const stripSequenceFields = new Set(policy.stripSequenceFields)

for (const relativePath of Object.keys(policy.excludeManifestFiles ?? {})) {
	const source = resolve(sourceRoot, relativePath)
	if (!existsSync(source)) fail(`configured excluded manifest was not found upstream: ${relativePath}`)
	if (policy.rules.includes(relativePath.replace(/^rules\//, '')))
		fail(`excluded manifest is also configured for inclusion: ${relativePath}`)
}

function fail(message) {
	throw new Error(`${TOOL}: ${message}`)
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

function writeExact(path, data) {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, data)
}

function copyExact(source, target) {
	mkdirSync(dirname(target), { recursive: true })
	copyFileSync(source, target)
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
	const key = content.slice(0, colon).trim()
	const value = content.slice(colon + 1).trim()
	return { indent, key, value }
}

function baseTrait(key) {
	let value = key.startsWith('-') ? key.slice(1) : key
	const suffix = value.indexOf('@')
	if (suffix >= 0) value = value.slice(0, suffix)
	return value
}

function withSingleFinalNewline(lines) {
	let value = lines.join('\n')
	while (value.endsWith('\n')) value = value.slice(0, -1)
	return `${value}\n`
}

function transformRules(text, label, removedCounts) {
	const lines = text.split('\n')
	const output = []
	let skippingIndent = -1
	for (const line of lines) {
		const node = nodeOf(line)
		if (skippingIndent >= 0) {
			if (node == null || node.indent > skippingIndent) continue
			skippingIndent = -1
		}
		if (node?.indent === 1) {
			const trait = baseTrait(node.key)
			if (removeTraits.has(trait)) {
				removedCounts.set(trait, (removedCounts.get(trait) ?? 0) + 1)
				skippingIndent = node.indent
				continue
			}
			if (trait === 'Inherits' && removeInherits.has(node.value)) {
				skippingIndent = node.indent
				continue
			}
		}
		output.push(line)
	}
	const transformed = withSingleFinalNewline(output)
	for (const line of transformed.split('\n')) {
		const node = nodeOf(line)
		if (node?.indent === 1 && removeTraits.has(baseTrait(node.key)))
			fail(`${label} retained forbidden trait ${node.key}`)
	}
	return transformed
}

/**
 * Drop warheads whose implementation reaches a world trait this policy removes.
 *
 * A stripped world trait is not inert: OpenRA resolves it with `Trait<T>()`, which THROWS
 * when it is absent. `ShakeScreen` reaches `ScreenShaker`, which `removeTraits` deletes, so
 * leaving the warhead in the weapon table arms a simulation-killing exception in every
 * weapon that carries it. Removing the consumer with the trait is what keeps the pair
 * consistent — see the sibling `ShakeOnDeath` entry in `removeTraits`.
 */
function transformWeapons(text, label, removedCounts) {
	const lines = text.split('\n')
	const output = []
	let skippingIndent = -1
	for (const line of lines) {
		const node = nodeOf(line)
		if (skippingIndent >= 0) {
			if (node == null || node.indent > skippingIndent) continue
			skippingIndent = -1
		}
		if (node?.indent === 1 && baseTrait(node.key) === 'Warhead' && removeWarheads.has(node.value)) {
			removedCounts.set(node.value, (removedCounts.get(node.value) ?? 0) + 1)
			skippingIndent = node.indent
			continue
		}
		output.push(line)
	}
	const transformed = withSingleFinalNewline(output)
	for (const line of transformed.split('\n')) {
		const node = nodeOf(line)
		if (node?.indent === 1 && baseTrait(node.key) === 'Warhead' && removeWarheads.has(node.value))
			fail(`${label} retained forbidden warhead ${node.key}: ${node.value}`)
	}
	return transformed
}

function transformSequences(text, label) {
	const lines = text.split('\n')
	const output = []
	let skippingIndent = -1
	let image = ''
	let sequence = ''
	for (const line of lines) {
		const node = nodeOf(line)
		if (node?.indent === 0) {
			image = node.key.toLowerCase()
			sequence = ''
		} else if (node?.indent === 1) sequence = node.key
		if (skippingIndent >= 0) {
			if (node == null || node.indent > skippingIndent) continue
			skippingIndent = -1
		}
		if (node != null && node.indent >= 2 && stripSequenceFields.has(node.key)) {
			skippingIndent = node.indent
			continue
		}
		if (node != null && node.indent >= 2 && node.key === 'Length' && node.value === '*') {
			let length = policy.wildcardSequenceLength
			if (node.indent === 2 && sequence === 'make') {
				length = effectiveMakeFrames(image, sequence, sequenceTiming.makeSequenceLengths[image], deploymentTiming)
				if (!Number.isInteger(length) || length <= 0)
					fail(`${label}:${image}.make has no witnessed gameplay timing`)
			}
			output.push(`${'\t'.repeat(node.indent)}Length: ${length}`)
			if (node.indent === 2 && image === 'fact' && sequence === 'make') output.push('\t\tTick: 40')
			continue
		}
		output.push(line)
	}
	const transformed = withSingleFinalNewline(output)
	for (const line of transformed.split('\n')) {
		const node = nodeOf(line)
		if (node != null && node.indent >= 2 && stripSequenceFields.has(node.key))
			fail(`${label} retained asset-binding sequence field ${node.key}`)
		if (node != null && node.indent >= 2 && node.key === 'Length' && node.value === '*')
			fail(`${label} retained an asset-sized wildcard sequence`)
	}
	return transformed
}

function copyNamed(folder, names, transform = null) {
	for (const name of names) {
		const source = resolve(sourceRoot, folder, name)
		if (!existsSync(source)) fail(`missing source ${relative(sourceRoot, source)}`)
		const target = resolve(outputRoot, folder, name)
		if (transform) writeExact(target, transform(readFileSync(source, 'utf8'), `${folder}/${name}`))
		else copyExact(source, target)
	}
}

function transformMap(text, label, removedCounts) {
	const output = []
	let inRules = false
	let skippingIndent = -1
	for (const line of text.split('\n')) {
		const node = nodeOf(line)
		if (skippingIndent >= 0) {
			if (node == null || node.indent > skippingIndent) continue
			skippingIndent = -1
		}
		if (node?.indent === 0) inRules = node.key === 'Rules'
		if (inRules && node?.indent === 2 && removeTraits.has(baseTrait(node.key))) {
			const trait = baseTrait(node.key)
			removedCounts.set(trait, (removedCounts.get(trait) ?? 0) + 1)
			skippingIndent = node.indent
			continue
		}
		output.push(line)
	}
	const transformed = withSingleFinalNewline(output)
	let checkingRules = false
	for (const line of transformed.split('\n')) {
		const node = nodeOf(line)
		if (node?.indent === 0) checkingRules = node.key === 'Rules'
		if (checkingRules && node?.indent === 2 && removeTraits.has(baseTrait(node.key)))
			fail(`${label} retained forbidden map-rule trait ${node.key}`)
	}
	return transformed
}

function copyMaps(removedCounts) {
	const sourceMaps = resolve(sourceRoot, 'maps')
	// The catalogue carries no Westwood-authored layout (vendor-policy.json mapExtraction.rejectAuthors).
	const rejectedAuthors = new Set(JSON.parse(readFileSync(resolve(engineRoot, 'openra/vendor-policy.json'), 'utf8')).mapExtraction.rejectAuthors)
	for (const mapId of readdirSync(sourceMaps).sort()) {
		for (const name of ['map.yaml', 'map.bin']) {
			const source = resolve(sourceMaps, mapId, name)
			if (!existsSync(source)) fail(`map ${mapId} is missing ${name}`)
			const target = resolve(outputRoot, 'maps', mapId, name)
			if (name === 'map.yaml') {
				const yaml = readFileSync(source, 'utf8')
				const author = /^Author:[ \t]*(.*)$/m.exec(yaml)?.[1].split(/[,/]/).map(part => part.trim()).find(part => rejectedAuthors.has(part))
				if (author) fail(`map ${mapId} is credited to ${author}, whose layouts the catalogue does not carry`)
				writeExact(target, transformMap(yaml, `maps/${mapId}/${name}`, removedCounts))
			} else copyExact(source, target)
		}
	}
}

function traitOpsForActor(lines, start, end) {
	const operations = []
	for (let index = start + 1; index < end; index++) {
		const node = nodeOf(lines[index])
		if (node?.indent !== 1) continue
		const fields = {}
		for (let childIndex = index + 1; childIndex < end; childIndex++) {
			const child = nodeOf(lines[childIndex])
			if (child?.indent <= 1) break
			if (child?.indent === 2) fields[child.key] = child.value
		}
		operations.push({ key: node.key, trait: baseTrait(node.key), value: node.value, fields })
	}
	return operations
}

function buildVisualManifest() {
	const listField = value => value == null || value === '' ? [] : value
		.replace(/^\[/, '').replace(/\]$/, '').split(',').map(item => item.trim()).filter(Boolean)
	const definitions = new Map()
	for (const name of policy.rules) {
		const lines = readFileSync(resolve(outputRoot, 'rules', name), 'utf8').split('\n')
		for (let start = 0; start < lines.length; start++) {
			const actor = nodeOf(lines[start])
			if (actor?.indent !== 0 || actor.key.startsWith('-')) continue
			let end = start + 1
			while (end < lines.length) {
				const next = nodeOf(lines[end])
				if (next?.indent === 0) break
				end++
			}
			definitions.set(actor.key.toLowerCase(), traitOpsForActor(lines, start, end))
			start = end - 1
		}
	}

	const resolved = new Map()
	function resolveActor(name, visiting = new Set()) {
		if (resolved.has(name)) return resolved.get(name)
		if (visiting.has(name)) fail(`visual manifest inheritance cycle at ${name}`)
		visiting.add(name)
		const traits = new Map()
		const operations = definitions.get(name) ?? []
		for (const operation of operations) {
			if (operation.trait !== 'Inherits') continue
			const inherited = resolveActor(operation.value.toLowerCase(), visiting)
			for (const [trait, descriptor] of inherited) traits.set(trait, descriptor)
		}
		for (const operation of operations) {
			if (operation.trait === 'Inherits') continue
			if (operation.key.startsWith('-')) traits.delete(operation.trait)
			else {
				const previous = traits.get(operation.trait)
				traits.set(operation.trait, {
					value: operation.value || previous?.value || '',
					fields: { ...(previous?.fields ?? {}), ...operation.fields },
				})
			}
		}
		visiting.delete(name)
		resolved.set(name, traits)
		return traits
	}

	const actors = {}
	for (const name of [...definitions.keys()].filter(value => !value.startsWith('^')).sort()) {
		const traits = resolveActor(name)
		const locomotor = traits.get('Mobile')?.fields.Locomotor ?? ''
		let visualFamily = 'generic'
		if (traits.has('Building')) visualFamily = 'structure'
		else if (traits.has('WithInfantryBody') || traits.has('WithDisguisingInfantryBody')) visualFamily = 'infantry'
		else if (traits.has('Aircraft'))
			visualFamily = traits.has('Hovers') || traits.get('Aircraft')?.fields.VTOL === 'true' || traits.get('Aircraft')?.fields.VTOL === 'True'
				? 'rotorcraft' : 'fixedwing'
		else if (traits.has('Husk')) visualFamily = 'wreck'
		else if (traits.has('Mobile')) {
			visualFamily = /naval|lcraft/.test(locomotor) || traits.has('RepairableNear')
				? 'vessel'
				: /wheel/.test(locomotor) ? 'wheeled' : 'tracked'
		}
		else if (traits.has('Immobile')) visualFamily = 'terrain-prop'
		actors[name] = {
			role: visualFamily === 'structure' || visualFamily === 'terrain-prop' ? 'structure'
				: visualFamily === 'wreck' ? 'wreck'
					: visualFamily === 'generic' ? 'generic' : 'unit',
			visualFamily,
			fallback: `procedural:${visualFamily}`,
			traits: [...traits.keys()].filter(value => !removeTraits.has(value)).sort(),
			...(locomotor ? { locomotor } : {}),
			...(traits.has('Building') ? {
				terrainTypes: listField(traits.get('Building')?.fields.TerrainTypes),
			} : {}),
			...(traits.has('Production') ? {
				productionTypes: listField(traits.get('Production')?.fields.Produces),
			} : {}),
			...(traits.has('Buildable') ? {
				buildPrerequisites: listField(traits.get('Buildable')?.fields.Prerequisites),
			} : {}),
		}
	}
	const projectileTypes = new Set()
	for (const name of policy.weapons) {
		for (const line of readFileSync(resolve(outputRoot, 'weapons', name), 'utf8').split('\n')) {
			const node = nodeOf(line)
			if (node?.indent === 1 && baseTrait(node.key) === 'Projectile' && node.value)
				projectileTypes.add(node.value)
		}
	}
	const terrainTypes = new Set()
	for (const name of policy.tilesets) {
		for (const line of readFileSync(resolve(outputRoot, 'tilesets', name), 'utf8').split('\n')) {
			const node = nodeOf(line)
			if (node?.key === 'Type' && node.indent === 2 && node.value) terrainTypes.add(node.value)
		}
	}
	return {
		schemaVersion: 1,
		sourceCommit: policy.sourceCommit,
		actors,
		projectiles: Object.fromEntries([...projectileTypes].sort().map(type => [type, { fallback: 'procedural:projectile' }])),
		terrain: Object.fromEntries([...terrainTypes].sort().map(type => [type, { fallback: 'procedural:terrain' }])),
		structures: Object.fromEntries(Object.entries(actors).filter(([, value]) => value.role === 'structure')),
	}
}

if (existsSync(outputRoot)) rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })

const removedCounts = new Map()
const removedWarheadCounts = new Map()
copyNamed('rules', policy.rules, (text, label) => transformRules(text, label, removedCounts))
copyNamed('weapons', policy.weapons, (text, label) => transformWeapons(text, label, removedWarheadCounts))
copyNamed('tilesets', policy.tilesets)
copyNamed('sequences', policy.sequences, transformSequences)
copyMaps(removedCounts)
installHeroBridge(outputRoot)

copyExact(resolve(hostRoot, 'mod/mod.yaml'), resolve(outputRoot, 'mod.yaml'))
copyExact(resolve(hostRoot, 'mod/cursors.yaml'), resolve(outputRoot, 'cursors.yaml'))
copyExact(resolve(hostRoot, 'mod/metrics.yaml'), resolve(outputRoot, 'metrics.yaml'))
copyExact(resolve(hostRoot, 'mod/assetless-presentation.yaml'), resolve(outputRoot, 'rules/assetless-presentation.yaml'))
copyExact(resolve(hostRoot, 'mod/deployment-rules.yaml'), resolve(outputRoot, 'rules/deployment-rules.yaml'))
copyExact(resolve(hostRoot, 'mod/notifications.yaml'), resolve(outputRoot, 'notifications.yaml'))
copyExact(resolve(hostRoot, 'mod/assetless'), resolve(outputRoot, 'assetless'))
copyExact(resolve(sourceRoot, 'fluent/ra.ftl'), resolve(outputRoot, 'fluent/ra.ftl'))
copyExact(resolve(sourceRoot, 'fluent/rules.ftl'), resolve(outputRoot, 'fluent/rules.ftl'))
copyExact(resolve(hostRoot, 'mod/host.ftl'), resolve(outputRoot, 'fluent/host.ftl'))

const missingConfiguredTraits = policy.removeTraits.filter(trait => !removedCounts.has(trait))
if (missingConfiguredTraits.length)
	fail(`configured removals were not found upstream: ${missingConfiguredTraits.join(', ')}`)

const missingConfiguredWarheads = [...removeWarheads].filter(warhead => !removedWarheadCounts.has(warhead))
if (missingConfiguredWarheads.length)
	fail(`configured warhead removals were not found upstream: ${missingConfiguredWarheads.join(', ')}`)

const visualManifest = buildVisualManifest()

// Map YAML is gameplay data and may preplace actors that never appear in a production queue.
// Prove that every such type uses the same deterministic fallback contract as runtime-created
// actors before publishing either manifest.
const mapActorTypes = new Set()
for (const mapId of readdirSync(resolve(outputRoot, 'maps')).sort()) {
	const lines = readFileSync(resolve(outputRoot, 'maps', mapId, 'map.yaml'), 'utf8').split('\n')
	let inActors = false
	for (const line of lines) {
		const node = nodeOf(line)
		if (node?.indent === 0) inActors = node.key === 'Actors'
		else if (inActors && node?.indent === 1 && node.value) mapActorTypes.add(node.value.toLowerCase())
	}
}
const missingMapVisuals = [...mapActorTypes].filter(type => visualManifest.actors[type] == null).sort()
if (missingMapVisuals.length)
	fail(`supported maps reference actors without procedural fallbacks: ${missingMapVisuals.join(', ')}`)
for (const [type, descriptor] of Object.entries(visualManifest.actors))
	if (!descriptor.fallback?.startsWith('procedural:')) fail(`actor ${type} has no deterministic procedural fallback`)
for (const [type, descriptor] of Object.entries(visualManifest.projectiles))
	if (!descriptor.fallback?.startsWith('procedural:')) fail(`projectile ${type} has no deterministic procedural fallback`)
for (const [type, descriptor] of Object.entries(visualManifest.terrain))
	if (!descriptor.fallback?.startsWith('procedural:')) fail(`terrain ${type} has no deterministic procedural fallback`)

// This is the stripped-YAML discovery index, not the public actor ABI. The authoritative
// ABI v2 is exported from resolved ActorInfo after the mod assembly has built by
// export-ra-catalog.mjs. Keeping these files distinct prevents a YAML approximation from
// overwriting defaults resolved by OpenRA itself.
writeExact(resolve(hostRoot, 'generated/ra-visual-source.json'), `${JSON.stringify(visualManifest, null, '\t')}\n`)

const report = {
	schemaVersion: 1,
	sourceCommit: policy.sourceCommit,
	policySha256: sha256(readFileSync(resolve(hostRoot, 'assetless-policy.json'))),
	removedTraits: Object.fromEntries([...removedCounts.entries()].sort()),
	removedWarheads: Object.fromEntries([...removedWarheadCounts.entries()].sort()),
	retainedGameplayCoupledPresentationTraits: policy.retainGameplayCoupledPresentationTraits,
	sequenceTimingSha256: sha256(readFileSync(resolve(hostRoot, 'sequence-timing.json'))),
	deploymentTimingSha256: sha256(readFileSync(resolve(hostRoot, 'deployment-timing.json'))),
	deploymentRulesSha256: sha256(readFileSync(resolve(hostRoot, 'mod/deployment-rules.yaml'))),
	steelseedMakeOverrides: deploymentTiming.overrides,
	protectedMakeSequenceCount: Object.keys(sequenceTiming.makeSequenceLengths).length,
	mapCount: readdirSync(resolve(outputRoot, 'maps')).length,
	actorVisualCount: Object.keys(visualManifest.actors).length,
	projectileVisualCount: Object.keys(visualManifest.projectiles).length,
	terrainVisualCount: Object.keys(visualManifest.terrain).length,
	mapActorVisualCount: mapActorTypes.size,
}
writeExact(resolve(hostRoot, 'generated/assetstrip-report.json'), `${JSON.stringify(report, null, '\t')}\n`)

// ---------------------------------------------------------------------------------------
// Dangling-consumer check.
//
// This exists because of a real, shipped defect. `ScreenShaker` was removed as presentation,
// but `ShakeOnDeath` and the `ShakeScreen` warhead reach it with `WorldActor.Trait<T>()` —
// which THROWS when the trait is absent. Nothing here noticed, so the first building
// destroyed in any match threw inside `World.Tick()`, the host caught it, latched itself off,
// and the simulation died while the camera kept flying over a frozen battlefield.
//
// A removed world trait is not inert. Anything that hard-requires it has to leave with it,
// and this is the check that says so at build time instead of five minutes into a match.
// ---------------------------------------------------------------------------------------
function assertNoDanglingWorldTraitConsumers() {
	const csharpRoots = ['openra/OpenRA.Game', 'openra/OpenRA.Mods.Common', 'openra/OpenRA.Mods.Cnc']
		.map(relativePath => resolve(engineRoot, relativePath))
		.filter(existsSync)
	if (csharpRoots.length === 0) return []

	const sources = []
	const pendingDirs = [...csharpRoots]
	while (pendingDirs.length) {
		const current = pendingDirs.pop()
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name)
			if (entry.isDirectory()) pendingDirs.push(path)
			else if (entry.isFile() && extname(entry.name) === '.cs') sources.push(path)
		}
	}

	// Yaml names a trait by its TraitInfo class minus 'Info', and a warhead by its Warhead
	// class minus 'Warhead'. Both are OpenRA-wide conventions. Requiring the base type as
	// well as the suffix is what keeps ordinary helper classes out of this set.
	const traitInfoDeclaration = /\bclass\s+([A-Za-z0-9_]+)Info\s*:[^{;]*\bTraitInfo\b/g
	const warheadDeclaration = /\bclass\s+([A-Za-z0-9_]+)Warhead\s*:[^{;]*\bWarhead\b/g
	const suspects = new Map()
	for (const path of sources) {
		const text = readFileSync(path, 'utf8')
		const required = [...removeTraits].filter(trait => text.includes(`Trait<${trait}>()`))
		if (required.length === 0) continue
		for (const pattern of [traitInfoDeclaration, warheadDeclaration])
			for (const match of text.matchAll(pattern)) suspects.set(match[1], required)
	}
	if (suspects.size === 0) return []

	const dangling = []
	const seen = new Set()
	const record = (name, label, where) => {
		const key = `${name}@${where}`
		if (seen.has(key)) return
		seen.add(key)
		dangling.push(`${label} '${name}' in ${where} needs removed world trait(s) ${suspects.get(name).join(', ')}`)
	}
	const pendingFiles = [outputRoot]
	while (pendingFiles.length) {
		const current = pendingFiles.pop()
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name)
			if (entry.isDirectory()) { pendingFiles.push(path); continue }
			if (!entry.isFile() || extname(entry.name) !== '.yaml') continue
			const where = relative(outputRoot, path).split(sep).join('/')
			for (const line of readFileSync(path, 'utf8').split('\n')) {
				const node = nodeOf(line)
				if (node == null || node.key.startsWith('-')) continue
				const key = baseTrait(node.key)
				if (key === 'Warhead') {
					if (suspects.has(node.value)) record(node.value, 'warhead', where)
				} else if (node.indent >= 1 && suspects.has(key)) record(key, 'trait', where)
			}
		}
	}
	return dangling
}

const dangling = assertNoDanglingWorldTraitConsumers()
if (dangling.length)
	fail(
		'the generated mod keeps consumers of world traits this policy removes — ' +
		'OpenRA resolves those with Trait<T>(), which throws and kills the simulation ' +
		`mid-match:\n  ${dangling.join('\n  ')}`,
	)

const forbiddenExtensions = new Set([
	'.aac', '.aud', '.avi', '.bmp', '.cur', '.dds', '.des', '.exr', '.fbx', '.flac',
	'.gif', '.glb', '.gltf', '.hdr', '.ico', '.int', '.jpeg', '.jpg', '.ktx', '.lua',
	'.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.obj', '.ogg', '.opus', '.otf', '.pal',
	'.png', '.shp', '.sno', '.svg', '.tem', '.tga', '.ttf', '.vqa', '.wav', '.webm',
	'.webp', '.woff', '.woff2', '.wsa',
])
const pending = [outputRoot]
while (pending.length) {
	const current = pending.pop()
	for (const name of readdirSync(current, { withFileTypes: true })) {
		const path = join(current, name.name)
		if (name.isDirectory()) pending.push(path)
		else if (forbiddenExtensions.has(extname(name.name).toLowerCase()))
			fail(`forbidden asset reached generated mod: ${relative(outputRoot, path).split(sep).join('/')}`)
	}
}

// ---------------------------------------------------------------------------------------
// T1.10: the map catalog (§5.4). For every map directory the generated mod ships,
// OpenRA's own `--map-hash` computes the uid (OpenRA's hash is the only authority —
// never a JavaScript reimplementation), with MOD_SEARCH_PATHS pointing at the
// generated mods so the utility resolves `ra`. Title and player count come from the
// map's own map.yaml. Two outputs land in the mod tree:
//   map-catalog.json — the full list the node validates room creation against
//   gate-map.json    — the entry titled "Marigold Town", which gates and the
//                      desktop selftest read instead of a hardcoded uid
// The utility is spawned from engine/ and receives the map path relative to bin/
// (OpenRA resolves relative paths against bin/, not the process cwd).
// ---------------------------------------------------------------------------------------
function utilityCommand() {
	const dll = resolve(engineRoot, 'bin/OpenRA.Utility.dll')
	if (!existsSync(dll))
		fail('OpenRA.Utility.dll is missing — build the host first; the map catalog needs the --map-hash utility')
	const apphost = resolve(engineRoot, 'bin/OpenRA.Utility')
	if (existsSync(apphost)) return { cmd: apphost, prefix: [] }
	const dotnetRoot = processEnv.DOTNET_ROOT ?? join(processEnv.HOME, '.dotnet')
	const dotnet = join(dotnetRoot, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')
	if (!existsSync(dotnet))
		fail('dotnet not found (PATH or $HOME/.dotnet) — needed to run OpenRA.Utility for the map catalog')
	return { cmd: dotnet, prefix: [dll] }
}

function writeMapCatalog() {
	const mapsRoot = resolve(outputRoot, 'maps')
	const { cmd, prefix } = utilityCommand()
	const utilityEnv = {
		...processEnv,
		MOD_SEARCH_PATHS: resolve(hostRoot, 'generated/mods'),
		...(processEnv.DOTNET_ROOT ? {} : { DOTNET_ROOT: join(processEnv.HOME, '.dotnet') }),
	}
	const speeds = []
	const modText = readFileSync(resolve(outputRoot, 'mod.yaml'), 'utf8')
	let inSpeeds = false
	for (const line of modText.split('\n')) {
		if (/^\tSpeeds:\s*$/.test(line)) { inSpeeds = true; continue }
		if (inSpeeds) {
			const name = /^\t\t([a-z]+):\s*$/.exec(line)
			if (name) speeds.push(name[1])
			else if (line.trim() && !line.startsWith('\t\t')) inSpeeds = false
		}
	}
	const binRoot = resolve(engineRoot, 'bin')
	const catalog = []
	for (const dir of readdirSync(mapsRoot).sort()) {
		const mapDir = resolve(mapsRoot, dir)
		if (!statSync(mapDir).isDirectory()) continue
		const rel = relative(binRoot, mapDir)
		const run = spawnSync(cmd, [...prefix, 'ra', '--map-hash', rel], { cwd: engineRoot, env: utilityEnv, encoding: 'utf8' })
		const uid = String(run.stdout ?? '').trim()
		if (run.status !== 0 || !/^[0-9a-f]{40}$/.test(uid))
			fail(`--map-hash failed for ${dir}: ${String(run.stderr ?? run.stdout ?? '').slice(0, 300)}`)
		const yaml = readFileSync(resolve(mapDir, 'map.yaml'), 'utf8')
		const title = /^Title:\s*(.+)$/m.exec(yaml)?.[1]?.trim() ?? dir
		const players = new Set([...yaml.matchAll(/PlayerReference@Multi\d+/g)].map(m => m[0])).size
		catalog.push({ uid, title, players, speeds })
	}
	if (catalog.length === 0) fail('the generated mod ships no maps — refusing to write an empty catalog')
	writeExact(resolve(outputRoot, 'map-catalog.json'), `${JSON.stringify(catalog, null, '\t')}\n`)
	const gate = catalog.find(entry => entry.title === 'Marigold Town')
	if (!gate) fail('the gate map "Marigold Town" is not among the generated maps')
	writeExact(resolve(outputRoot, 'gate-map.json'), `${JSON.stringify(gate, null, '\t')}\n`)
	console.log(`${TOOL}: catalog ${catalog.length} maps, gate ${gate.uid} ("${gate.title}", ${gate.players} players)`)
	return catalog
}

writeMapCatalog()

// ---------------------------------------------------------------------------------------
// T2.1: the sim build id (§5.8). The version the mod presents is a content id, not a
// constant: it covers the finished mod tree (map catalog included) with the Version
// line blanked — the stamp carries the id itself, so hashing it verbatim would be
// circular — plus the pinned simulation sources and the server-side assemblies, and
// deliberately nothing from web/, desktop/ or art/. build.json records simBuild and
// modHash for the node's start-up verification (roomhost recomputes modTreeHash over
// the mod directory it launches) and for compose to publish alongside the AppBundle.
// ---------------------------------------------------------------------------------------
const simBuild = computeSimBuild(engineRoot)
const modHash = modTreeHash(outputRoot)
const generatedManifest = resolve(outputRoot, 'mod.yaml')
const manifestText = readFileSync(generatedManifest, 'utf8')
const versionLine = /^(\t*)Version:.*$/m
if (!versionLine.test(manifestText))
	fail('generated mod.yaml has no Version: line to stamp')
writeFileSync(generatedManifest, manifestText.replace(versionLine, `$1Version: ${MOD_VERSION_TAG}-${simBuild}`))
writeExact(resolve(hostRoot, 'generated/build.json'), `${JSON.stringify({ schema: 1, simBuild, modHash }, null, '\t')}\n`)
console.log(`${TOOL}: simBuild ${simBuild}, modHash ${modHash.slice(0, 12)}…`)

console.log(
	`${TOOL}: PASS maps=${report.mapCount} actors=${report.actorVisualCount} mapActors=${report.mapActorVisualCount} ` +
	`projectiles=${report.projectileVisualCount} terrain=${report.terrainVisualCount} removed=${removedCounts.size}`,
)
