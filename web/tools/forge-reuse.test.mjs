import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inputFiles, inputFingerprint, canReuseForge, recordForge } from './forge-reuse.mjs'

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'forge-reuse-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const put = (name, bytes) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), bytes) }
	for (const name of ['art/blender/assets/tank.blend', 'art/blender/assets/living/fence.blend',
		'art/blender/export_assets.py', 'art/blender/living_assets.py', 'art/blender/fencegate.py',
		'art/blender/living_catalog.py', 'art/blender/index_assets.py', 'art/blender/assets/index.json', 'art/sources.lock.json']) put(name, 'source')
	for (const name of inputFiles('blender', root).filter(name => name.startsWith('web/'))) put(name, 'input')
	for (const name of ['blender/manifest.json', 'blender/roster.ssasset.gz', 'living/manifest.json', 'living/living.ssasset.gz']) put(`web/.forge/${name}`, 'output')
	return { root, put }
}
test('a fence source or recipe change preserves all unchanged non-living export bytes', t => {
	const { root, put } = fixture(t)
	recordForge('blender', root); recordForge('living', root)
	put('art/blender/assets/living/fence.blend', 'fixed posts')
	put('art/blender/living_assets.py', 'fixed fence recipe')
	put('art/blender/fencegate.py', 'contact check')
	put('art/blender/assets/index.json', 'refreshed inventory')
	assert.equal(canReuseForge('blender', root), true)
	assert.equal(canReuseForge('living', root), false)
})
test('source, exporter, palette, source lock and tool changes invalidate the export', t => {
	const { root, put } = fixture(t)
	for (const name of ['art/blender/assets/tank.blend', 'art/blender/export_assets.py',
		'art/sources.lock.json', 'web/src/core/blender-palette.json', 'web/tools/blender-forge.mjs']) {
		recordForge('blender', root); put(name, 'changed ' + name)
		assert.equal(canReuseForge('blender', root), false, name)
	}
})
test('missing records, corrupt output, additional output and removed output cannot be reused', t => {
	const { root, put } = fixture(t)
	assert.equal(canReuseForge('blender', root), false)
	recordForge('blender', root); assert.equal(canReuseForge('blender', root), true)
	put('web/.forge/blender/roster.ssasset.gz', 'corrupt')
	assert.equal(canReuseForge('blender', root), false)
	recordForge('blender', root); put('web/.forge/blender/unrecorded.bin', 'extra')
	assert.equal(canReuseForge('blender', root), false)
	recordForge('blender', root); rmSync(join(root, 'web/.forge/blender/manifest.json'))
	assert.equal(canReuseForge('blender', root), false)
})
test('a source change during export cannot stamp an apparently fresh output', t => {
	const { root, put } = fixture(t), before = inputFingerprint('blender', root)
	put('art/blender/assets/tank.blend', 'edited during export')
	assert.throws(() => recordForge('blender', root, before), /changed during export/)
	assert.equal(canReuseForge('blender', root), false)
})
