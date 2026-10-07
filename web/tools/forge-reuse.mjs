// Reuse an export only when every declared input and every output byte matches.
// A cache hit alone is insufficient. Missing records cause a normal full export.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const game = resolve(import.meta.dirname, '../..')
const directories = {
	blender: ['blender'], environment: ['environment'], living: ['living'],
	materials: ['surfaces', 'ground', 'foliage', 'meadow'], trees: ['tree-lods'],
}
const tools = ['blender-forge.mjs', 'environment-forge.mjs', 'living-forge.mjs', 'material-forge.mjs',
	'tree-forge.mjs', 'art-fetch.mjs', 'sourcelicensegate.mjs', 'forge-reuse.mjs']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function files(root, directory) {
	if (!existsSync(join(root, directory))) return []
	const result = []
	for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
		if (entry.name.startsWith('.') || entry.name === '__pycache__') continue
		const name = `${directory}/${entry.name}`
		assert.ok(!entry.isSymbolicLink(), `Forge input/output cannot be a symlink: ${name}`)
		if (entry.isDirectory()) result.push(...files(root, name))
		else if (entry.isFile()) result.push(name)
	}
	return result.sort()
}
export function inputFiles(group, root = game) {
	assert.ok(directories[group], `Unknown forge group: ${group}`)
	// Conservative: all authored art feeds every group, except the isolated
	// living recipes/scenes for non-living groups. The aggregate index is output.
	const art = files(root, 'art').filter(name => !/\.(?:blend\d+|pyc|tmp)$/.test(name))
	const selected = art.filter(name => name !== 'art/blender/assets/index.json' &&
		(group === 'living' || !(name.startsWith('art/blender/assets/living/') ||
			['art/blender/living_assets.py', 'art/blender/living_catalog.py', 'art/blender/fencegate.py', 'art/blender/index_assets.py'].includes(name))))
	const shared = ['web/src/core/blender-palette.json', 'web/src/render/gpumesh.ts',
		'web/src/units/ra-visual-manifest.json', 'web/package-lock.json', ...tools.map(name => `web/tools/${name}`)]
	if (group === 'trees') shared.push('web/.forge/foliage/manifest.json', 'web/.forge/foliage/foliage.sspbr.gz')
	return [...new Set([...selected, ...shared])].sort()
}
export function inputFingerprint(group, root = game) {
	const hash = createHash('sha256').update('forge-reuse-v1;blender=5.2.1\n')
	for (const name of inputFiles(group, root)) hash.update(name + '\0').update(readFileSync(join(root, name))).update('\0')
	return hash.digest('hex')
}
function outputFiles(group, root) {
	const result = directories[group].flatMap(name => files(root, `web/.forge/${name}`))
	assert.ok(result.length && directories[group].every(name => result.some(file => file.startsWith(`web/.forge/${name}/`))), `Missing ${group} export`)
	return result.sort()
}
function records(root) {
	const file = join(root, 'web/.forge/export-inputs.json')
	if (!existsSync(file)) return { schema: 1, groups: {} }
	const data = JSON.parse(readFileSync(file, 'utf8'))
	assert.equal(data.schema, 1); assert.ok(data.groups && typeof data.groups === 'object')
	return data
}
export function canReuseForge(group, root = game) {
	try {
		const record = records(root).groups[group]
		if (!record || record.inputs !== inputFingerprint(group, root)) return false
		const names = outputFiles(group, root)
		if (JSON.stringify(names) !== JSON.stringify(Object.keys(record.outputs).sort())) return false
		return names.every(name => lstatSync(join(root, name)).isFile() && sha(readFileSync(join(root, name))) === record.outputs[name])
	} catch { return false }
}
export function recordForge(group, root = game, expectedInputs) {
	const data = records(root)
	const inputs = inputFingerprint(group, root)
	if (expectedInputs !== undefined) assert.equal(inputs, expectedInputs, 'Forge inputs changed during export; refusing to stamp stale output')
	data.groups[group] = { inputs, outputs: Object.fromEntries(outputFiles(group, root).map(name => [name, sha(readFileSync(join(root, name)))])) }
	const file = join(root, 'web/.forge/export-inputs.json')
	writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n'); renameSync(file + '.tmp', file)
}
export function reuseForge(group) {
	if (!canReuseForge(group)) return false
	console.log(`forge:${group}: verified inputs and outputs unchanged; retaining exact export bytes`)
	return true
}
