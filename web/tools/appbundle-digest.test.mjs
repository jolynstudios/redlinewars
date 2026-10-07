import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeDigest } from './appbundle-digest.mjs'

test('the runtime digest covers every loadable file and ignores per-build source maps and inventory', () => {
	const dir = mkdtempSync(join(tmpdir(), 'appbundle-digest-'))
	try {
		mkdirSync(join(dir, 'steelseed/assets'), { recursive: true })
		writeFileSync(join(dir, 'steelseed/assets/units-A1.js'), 'export const units = 1\n')
		writeFileSync(join(dir, 'steelseed/assets/units-A1.js.map'), '{"sourcesContent":["__VITE_ASSET__DH3a9ffR__"]}')
		writeFileSync(join(dir, 'steelseed/composition.json'), '{"files":[{"path":"assets/units-A1.js.map","sha256":"aa"}]}')
		writeFileSync(join(dir, 'dotnet.native.wasm'), 'wasm')
		const first = runtimeDigest(dir)
		assert.equal(first.files, 2)
		writeFileSync(join(dir, 'steelseed/assets/units-A1.js.map'), '{"sourcesContent":["__VITE_ASSET__DxIuUMKw__"]}')
		writeFileSync(join(dir, 'steelseed/composition.json'), '{"files":[{"path":"assets/units-A1.js.map","sha256":"bb"}]}')
		assert.deepEqual(runtimeDigest(dir), first)
		writeFileSync(join(dir, 'dotnet.native.wasm'), 'wasm2')
		assert.notEqual(runtimeDigest(dir).sha256, first.sha256)
		writeFileSync(join(dir, 'dotnet.native.wasm'), 'wasm')
		writeFileSync(join(dir, 'steelseed/extra.json'), '{}')
		assert.equal(runtimeDigest(dir).files, 3)
		assert.notEqual(runtimeDigest(dir).sha256, first.sha256)
	} finally { rmSync(dir, { recursive: true, force: true }) }
	assert.throws(() => runtimeDigest(mkdtempSync(join(tmpdir(), 'appbundle-empty-'))), /No game files/)
})
