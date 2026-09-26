// tools/verify-release.mjs can fail: a small AppBundle and the checkout it was built from pass,
// and each broken copy fails for its own reason.
//
//   node --test tools/verify-release.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const repo = resolve(import.meta.dirname, '..')
const verifier = join(repo, 'tools/verify-release.mjs')
const SOURCE_TS = 'export const answer = 42\n'
const NOTICES = 'OpenRA (c) The OpenRA Developers and Contributors, GNU GPL v3 or later. MP3Sharp (LGPL v3), TagLib# (LGPL v2.1), FuzzyLogicLibrary (GPL v2). Archivo: SIL Open Font License 1.1.\n'
const BUILD = { schema: 1, simBuild: 'c0ffee000000', modHash: 'f'.repeat(64) }

const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const walk = (dir, base = dir) => readdirSync(dir).flatMap(name => {
	const path = join(dir, name)
	return statSync(path).isDirectory() ? walk(path, base) : [path.slice(base.length + 1)]
})

/** A checkout and an AppBundle built from it; `change` breaks the AppBundle before its composition is written. */
function fixture(change = () => {}) {
	const root = mkdtempSync(join(tmpdir(), 'verify-release-test-'))
	const checkout = join(root, 'checkout'), bundle = join(root, 'AppBundle'), steelseed = join(bundle, 'steelseed')
	write(join(checkout, 'RELEASE-SOURCE.json'), JSON.stringify({ sourceCommit: 'a'.repeat(40) }))
	cpSync(join(repo, 'LICENSE'), join(checkout, 'engine/COPYING'))
	write(join(checkout, 'engine/AUTHORS'), 'OpenRA authors\n')
	for (const name of ['GPL-2.0.txt', 'LGPL-2.1.txt', 'LGPL-3.0.txt']) cpSync(join(repo, 'licenses', name), join(checkout, 'engine/licenses', name))
	write(join(checkout, 'web/src/answer.ts'), SOURCE_TS)
	write(join(checkout, 'engine/steelseed-host/generated/build.json'), JSON.stringify(BUILD))

	write(join(steelseed, 'build.json'), JSON.stringify(BUILD))
	write(join(steelseed, 'assets/index.js'), 'console.log(42)\n//# sourceMappingURL=index.js.map\n')
	write(join(steelseed, 'assets/index.js.map'), JSON.stringify({ version: 3, sources: ['../../src/answer.ts'], sourcesContent: [SOURCE_TS], mappings: '' }))
	cpSync(join(checkout, 'engine/COPYING'), join(steelseed, 'licenses/COPYING-GPLv3.txt'))
	cpSync(join(checkout, 'engine/AUTHORS'), join(steelseed, 'licenses/AUTHORS-OpenRA.txt'))
	write(join(steelseed, 'licenses/THIRD-PARTY-NOTICES.txt'), NOTICES)
	for (const name of ['GPL-2.0.txt', 'LGPL-2.1.txt', 'LGPL-3.0.txt']) cpSync(join(checkout, 'engine/licenses', name), join(steelseed, 'licenses', name))
	change({ checkout, steelseed })
	const files = walk(steelseed).filter(path => path !== 'composition.json').map(path => ({ path, sha256: sha256(join(steelseed, path)) }))
	write(join(steelseed, 'composition.json'), JSON.stringify({ schema: 1, files }))
	return { root, checkout, bundle }
}

function verify({ checkout, bundle }) {
	const run = spawnSync(process.execPath, [verifier, '--source', checkout, bundle], { encoding: 'utf8' })
	return { status: run.status, output: run.stdout + run.stderr }
}

test('an AppBundle built from its checkout passes', () => {
	const f = fixture()
	try {
		const { status, output } = verify(f)
		assert.equal(status, 0, output)
		assert.match(output, /1 web\/src files embedded in 1 source maps are byte-equal/)
		assert.match(output, /LGPL v3 text: equal to engine\/licenses\/LGPL-3\.0\.txt/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const [what, change, pattern] of [
	['a source that differs from the checkout', ({ steelseed }) => write(join(steelseed, 'assets/index.js.map'),
		JSON.stringify({ version: 3, sources: ['../../src/answer.ts'], sourcesContent: ['export const answer = 41\n'], mappings: '' })), /web\/src files differ/],
	['a map without its sources\' content', ({ steelseed }) => write(join(steelseed, 'assets/index.js.map'),
		JSON.stringify({ version: 3, sources: ['../../src/answer.ts'], mappings: '' })), /without embedded content/],
	['no source map at all', ({ steelseed }) => rmSync(join(steelseed, 'assets/index.js.map')), /no source maps/],
	['a GPL text that is not the checkout\'s', ({ steelseed }) => write(join(steelseed, 'licenses/COPYING-GPLv3.txt'), 'All rights reserved.\n'), /GPL text: differs from engine\/COPYING/],
	['notices that leave out a bundled library', ({ steelseed }) => write(join(steelseed, 'licenses/THIRD-PARTY-NOTICES.txt'), NOTICES.replace('MP3Sharp', 'a decoder')), /does not credit MP3Sharp/],
	['a missing LGPL text', ({ steelseed }) => rmSync(join(steelseed, 'licenses/LGPL-2.1.txt')), /LGPL v2\.1 text: missing/],
]) {
	test(`the verifier refuses ${what}`, () => {
		const f = fixture(change)
		try {
			const { status, output } = verify(f)
			assert.equal(status, 1, `expected a FAIL for ${what}:\n${output}`)
			assert.match(output, pattern)
		} finally { rmSync(f.root, { recursive: true, force: true }) }
	})
}
