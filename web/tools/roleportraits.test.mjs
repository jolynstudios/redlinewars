import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('missing optional portrait tooling leaves the build usable', () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), 'redline-roleportraits-')))
	try {
		// A fresh checkout may lack tool dependencies before installation. The
		// portrait stage promises a roster fallback even if its bundler cannot load.
		for (const name of ['roleportraits.mjs', 'png.mjs'])
			copyFileSync(new URL(name, import.meta.url), join(directory, name))
		const result = spawnSync(process.execPath, [join(directory, 'roleportraits.mjs')], { encoding: 'utf8' })
		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stderr, /roleportraits: skipped, roster portraits stand/)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
