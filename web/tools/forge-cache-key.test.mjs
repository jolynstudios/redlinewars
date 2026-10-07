// The deploy workflow caches the Blender export (web/.forge) under a key that must name
// every input `npm run forge:assets` reads — no more (a gate or test edit must not re-run a
// 4-5 minute export) and never less (a missed input ships a stale export). This recomputes
// both import closures from the scripts the forge actually launches and checks that every
// file they read outside art/ is in the key.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import { test } from 'node:test'

const web = resolve(import.meta.dirname, '..')
const game = resolve(web, '..')
// The deploy workflow is private infrastructure: a public checkout has none, and nothing to check.
const workflowFile = join(game, '.github/workflows/deploy.yml')
const PRIVATE = existsSync(workflowFile) ? false : 'the deploy workflow is not in this checkout (it is private infrastructure)'
const workflow = PRIVATE ? '' : readFileSync(workflowFile, 'utf8')
const keyLine = workflow.split('\n').find(line => line.includes('echo "forge=${{ hashFiles('))
const patterns = [...(keyLine ?? '').matchAll(/'([^']+)'/g)].map(m => m[1])
const covered = file => patterns.some(p => p === file || (p.endsWith('/**') && file.startsWith(p.slice(0, -2))))

/** Node side: the forge scripts, and every relative .mjs they import or run with node. */
function nodeClosure() {
	const scripts = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')).scripts
	const forge = new Set()
	const expand = name => {
		for (const part of scripts[name].split('&&').map(s => s.trim())) {
			const npm = /^npm run ([\w:-]+)$/.exec(part)
			if (npm) expand(npm[1])
			const node = /^node (tools\/[\w.-]+\.mjs)/.exec(part)
			if (node) forge.add(node[1])
		}
	}
	expand('forge:assets')
	const seen = new Set()
	const stack = [...forge].map(f => join(web, f))
	while (stack.length) {
		const file = stack.pop()
		if (seen.has(file) || !existsSync(file)) continue
		seen.add(file)
		const src = readFileSync(file, 'utf8')
		for (const m of src.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) stack.push(normalize(join(dirname(file), m[1])))
		for (const m of src.matchAll(/resolve\(import\.meta\.dirname,\s*'([\w.-]+\.mjs)'\)/g)) stack.push(join(dirname(file), m[1]))
	}
	return { forge: [...forge], files: [...seen].map(f => relative(game, f)) }
}

/** Python side: every script the forge tools hand to Blender or python3, and its imports. */
function pythonClosure(forgeTools) {
	const blender = join(game, 'art/blender')
	const modules = new Set(readdirSync(blender).filter(f => f.endsWith('.py')).map(f => f.slice(0, -3)))
	const entries = new Set()
	for (const tool of forgeTools) {
		const src = readFileSync(join(web, tool), 'utf8')
		// Bare names ('export_assets.py') and paths ('art/blender/tree_lods.py') both launch a script.
		for (const m of src.matchAll(/[/'"`]([\w-]+\.py)['"`]/g)) if (modules.has(m[1].slice(0, -3))) entries.add(m[1])
	}
	const forgeIndex = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')).scripts['forge:index'] ?? ''
	for (const m of forgeIndex.matchAll(/([\w-]+\.py)/g)) entries.add(m[1])
	const seen = new Set()
	const stack = [...entries]
	while (stack.length) {
		const file = stack.pop()
		if (seen.has(file)) continue
		seen.add(file)
		const src = readFileSync(join(blender, file), 'utf8')
		for (const m of src.matchAll(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w., ]*))/gm)) {
			const names = m[1] ? [m[1]] : m[2].split(',').map(n => n.trim().split(' as ')[0])
			for (const n of names) if (modules.has(n.split('.')[0])) stack.push(`${n.split('.')[0]}.py`)
		}
	}
	const inputs = new Set()
	for (const file of seen) for (const line of readFileSync(join(blender, file), 'utf8').split('\n')) {
		const code = line.split('#')[0]
		for (const m of code.matchAll(/((?:web\/src|web\/tools|engine)\/[\w./-]+\.(?:json|ts|mjs|yaml|js|txt))/g)) inputs.add(m[1])
	}
	return { entries: [...entries], inputs: [...inputs] }
}

test('the forge cache key is present and scoped', { skip: PRIVATE }, () => {
	assert.ok(patterns.length > 0, 'deploy.yml has a forge= hashFiles key')
	assert.ok(patterns.includes('art/**'), 'every authored source is an input')
	assert.ok(!patterns.includes('web/tools/**'), 'gate and test edits must not re-run the export')
})

test('every tool the forge runs is in the key', { skip: PRIVATE }, () => {
	const { forge, files } = nodeClosure()
	assert.ok(forge.length >= 4, `forge:assets launches its tools (${forge.join(', ')})`)
	for (const file of files) assert.ok(covered(file), `${file} feeds the export but is not in the forge cache key`)
})

test('every file the export scripts read outside art/ is in the key', { skip: PRIVATE }, () => {
	const { forge } = nodeClosure()
	const { entries, inputs } = pythonClosure(forge)
	assert.ok(entries.includes('export_assets.py'), `the Blender entry scripts were found (${entries.join(', ')})`)
	for (const file of inputs) assert.ok(covered(file), `${file} is read by the export but is not in the forge cache key`)
})
