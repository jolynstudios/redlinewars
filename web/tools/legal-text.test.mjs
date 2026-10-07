// Public edition notice distribution. This verifies packaging facts, not legal clearance.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')
const read = file => readFileSync(join(root, file), 'utf8')

test('minimal interface exposes copyright, warranty, licence and source without leaving the game', () => {
	const html = read('web/index.html')
	const panel = html.match(/<details id="legal">([\s\S]*?)<\/details>/)?.[1]
	assert.ok(panel, 'the legal panel is present and can be opened')
	assert.match(panel, /<summary>Licence &amp; source<\/summary>/)
	assert.match(panel, /© 2026 Jolyn Studios/)
	assert.match(panel, /The OpenRA Developers and Contributors/)
	assert.match(panel, /GNU GPL version 3 or later, without warranty/)
	assert.match(panel, /https:\/\/github.com\/jolynstudios\/redlinewars/)
	for (const link of panel.match(/<a [^>]+>/g) ?? []) {
		assert.match(link, /target="_blank"/)
		assert.match(link, /rel="noopener"/)
	}
})

test('composition ships GPL, upstream authors, runtime and third-party notices', () => {
	const compose = read('web/tools/compose.mjs')
	assert.match(read('LICENSE'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/)
	assert.match(read('engine/COPYING'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/)
	for (const [source, output] of [
		['engine/COPYING', 'COPYING-GPLv3.txt'],
		['engine/AUTHORS', 'AUTHORS-OpenRA.txt'],
		['THIRD_PARTY_NOTICES.md', 'THIRD-PARTY-NOTICES.txt'],
		['engine/licenses/GPL-2.0.txt', 'GPL-2.0.txt'],
		['engine/licenses/LGPL-2.1.txt', 'LGPL-2.1.txt'],
		['engine/licenses/LGPL-3.0.txt', 'LGPL-3.0.txt'],
	]) {
		assert.ok(existsSync(join(root, source)), `licence source exists: ${source}`)
		assert.ok(compose.includes(`['${source}', '${output}']`), `composition includes ${output}`)
	}
	assert.match(compose, /cpSync\(dotnetNotices, join\(licences, 'DOTNET-THIRD-PARTY-NOTICES\.txt'\)\)/)
})
