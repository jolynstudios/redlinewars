// One copyright and credits text everywhere it is shown or shipped.
//
// The engine is OpenRA's work (GPLv3). The Redline Wars software, the engine and its WebAssembly port,
// the WebGPU client, the desktop app, the multiplayer and server code and the tools, is available under
// the GNU GPL v3 or later; the creative files are separately licensed. Jolyn Studios is the holder on
// every surface. Every surface must credit OpenRA and name the same source location; none may reserve
// the software or claim what the provenance disproves. What the game itself shows names nobody; people
// are named on the website's credits page (and the builder's own story).
//
// The public tree (github.com/jolynstudios/redlinewars) holds only part of these surfaces, and a
// public LICENSE with the GPL text: each check reads what the tree has.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')
// Line wraps in Markdown and HTML must not hide a phrase: collapse whitespace before matching.
const read = path => readFileSync(join(root, path), 'utf8').replace(/\s+/g, ' ')
const present = paths => paths.filter(path => existsSync(join(root, path)))
const HOLDER = '© 2026 Jolyn Studios'
const SOURCE = 'github.com/jolynstudios/redlinewars'
const OPENRA = 'The OpenRA Developers and Contributors'
const GPL_SOFTWARE = /The Redline Wars software[^.]*available under the GNU GPL v3 or later/

/** Surfaces that carry the full statement (long text). */
const LONG = [
	'web/index.html',
	'landing/credits.html',
	'landing/src/partials/footer.html',
	'THIRD_PARTY_NOTICES.md',
	'brand/README.md',
	'desktop/shell-options.mjs',
	'desktop/shell/landing.html',
]
/** Surfaces that must at least credit the engine and its source. The public repository's LICENSE is
 *  the GPL text itself, which credits no one; the private one states the split. */
const PRIVATE_LICENCE = /This repository holds work under two licences/.test(readFileSync(join(root, 'LICENSE'), 'utf8'))
const SHORT = [...(PRIVATE_LICENCE ? ['LICENSE'] : []), 'README.md', 'landing/public/llms.txt']
/** Desktop surfaces without the full text. */
const DESKTOP = ['desktop/main.mjs']
/** The owner's name belongs to the story of how the game was built, nowhere else. */
const STORY = ['BLOG-HOW-WE-DID-IT.md', 'landing/story.html']

const sentences = text => text.replace(/<[^>]+>/g, ' ').split(/(?<=[.!?])\s+/)
/** What the game shows as its copyright and credits: the in-game panel and the desktop's sheet. */
const inGame = () => {
	const out = []
	if (existsSync(join(root, 'web/index.html'))) {
		const html = read('web/index.html'), start = html.indexOf('<div class="copyright-body">')
		out.push(['web/index.html copyright panel', html.slice(start, html.indexOf('</div>', start))])
	}
	if (existsSync(join(root, 'desktop/shell/landing.html'))) {
		const html = read('desktop/shell/landing.html'), start = html.indexOf('<div id="credits-sheet"')
		out.push(['desktop credits sheet', html.slice(start, html.indexOf('data-legal="license"', start))])
	}
	if (existsSync(join(root, 'desktop/shell-options.mjs'))) {
		const code = read('desktop/shell-options.mjs')
		out.push(['desktop LEGAL_LONG', code.slice(code.indexOf('export const LEGAL_LONG'), code.indexOf('export const LEGAL_SHORT'))])
	}
	return out
}

test('every surface credits OpenRA and names one holder and one source', () => {
	for (const path of present(LONG)) {
		const text = read(path)
		assert.ok(text.includes(OPENRA), `${path}: credits ${OPENRA}`)
		assert.ok(text.includes(SOURCE), `${path}: points to ${SOURCE}`)
		assert.ok(text.includes(HOLDER), `${path}: names ${HOLDER}`)
		assert.match(text, /EA has not endorsed and does not support this product/, `${path}: the EA line`)
	}
	for (const path of present(SHORT)) {
		const text = read(path)
		assert.match(text, /OpenRA/, `${path}: credits OpenRA`)
		assert.ok(text.includes(SOURCE), `${path}: points to ${SOURCE}`)
	}
})

test('the software is GPL on every surface that states it, and nothing reserves it', () => {
	for (const path of present(['web/index.html', 'landing/credits.html', 'landing/src/partials/footer.html', 'desktop/shell-options.mjs', 'desktop/shell/landing.html']))
		assert.match(read(path), GPL_SOFTWARE, `${path}: the software is under the GNU GPL v3 or later`)
	for (const path of [...present([...LONG, ...SHORT, ...DESKTOP]), ...present(STORY)]) {
		const text = read(path)
		assert.doesNotMatch(text, /original engine code/i, `${path}: the engine is OpenRA's`)
		assert.doesNotMatch(text, /every model and sound was made for it/i, `${path}: supplied inputs and CC0 sources exist`)
		assert.doesNotMatch(text, /All shipped art is authored in this repository/i, `${path}: supplied inputs exist`)
		for (const sentence of sentences(text).filter(s => /all rights reserved/i.test(s)))
			assert.doesNotMatch(sentence, /\bengine\b|webassembly|multiplayer|server|webgpu|presentation layer|desktop app|\btools\b/i,
				`${path}: "${sentence.trim().slice(0, 90)}…" reserves GPL software`)
	}
	if (existsSync(join(root, 'README.md')))
		assert.doesNotMatch(read('README.md'), /copied byte-for-byte|ships with complete corresponding source/, 'README: provenance claims match the tree')
})

test("Jolyn Studios is the holder; the owner's name stays in the story of how it was built", () => {
	for (const path of present([...LONG, ...SHORT, ...DESKTOP, 'desktop/package.mjs', 'engine/steelseed-host/tools/pack-node.mjs', 'landing/index.html', 'landing/vite.config.ts', 'NOTICE.md']))
		assert.doesNotMatch(read(path), /Felixdaal/, `${path}: the holder is Jolyn Studios`)
})

test('what the game shows names nobody', () => {
	for (const [where, text] of inGame())
		assert.doesNotMatch(text, /Felixdaal|Ozler|\bIsa\b|Jermaine|Sebastiaan|Steur|\bJong\b|Rikie|Anthony/, `${where}: names a person`)
})

test('the website footer: no em dash, no arrow, no cast line', () => {
	if (!existsSync(join(root, 'landing/src/partials/footer.html'))) return
	const footer = read('landing/src/partials/footer.html')
	assert.doesNotMatch(footer, /—|→/, 'the footer uses no em dash or arrow')
	assert.doesNotMatch(footer, /cast is real/i)
})

test('the licence split is written down where the tools look for it', () => {
	const licence = read('LICENSE')
	if (/This repository holds work under two licences/.test(licence)) {
		// The private repository's LICENSE: the software under the GPL, the creative files apart.
		assert.match(licence, /GNU General Public License, version 3 or later/)
		assert.match(licence, /engine\//)
		assert.match(licence, /WebGPU client \(web\/\)/)
		assert.match(licence, /desktop app \(desktop\/\)/)
		assert.doesNotMatch(licence, /Proprietary/)
	} else {
		// The public repository: LICENSE is the GPL text, NOTICE.md says what it covers.
		assert.match(licence, /GNU GENERAL PUBLIC LICENSE Version 3/)
		const notice = read('NOTICE.md')
		assert.match(notice, /either version 3 of the License, or \(at your option\) any later version/)
		for (const dir of ['engine/', 'web/', 'desktop/', 'tools/']) assert.ok(notice.includes(dir), `NOTICE.md covers ${dir}`)
	}
	assert.ok(existsSync(join(root, 'engine/COPYING')), 'the GPL text stays in engine/COPYING')
	assert.match(read('engine/COPYING'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/)
	// The AppBundle, the node zips and the npm package carry the GPL text.
	assert.match(read('web/tools/compose.mjs'), /\['engine\/COPYING', 'COPYING-GPLv3\.txt'\]/)
	assert.match(read('engine/steelseed-host/tools/pack-node.mjs'), /COPYING-GPLv3\.txt/)
	assert.match(read('engine/steelseed-host/tools/pack-npm.mjs'), /license: 'GPL-3\.0-or-later'/)
	// The bundled libraries' licences (FuzzyLogicLibrary GPL v2, TagLib# LGPL v2.1, MP3Sharp LGPL v3)
	// travel with the AppBundle, the node zips, the npm package and the desktop app.
	for (const [name, heading] of [['GPL-2.0.txt', /GNU GENERAL PUBLIC LICENSE Version 2, June 1991/], ['LGPL-2.1.txt', /GNU LESSER GENERAL PUBLIC LICENSE Version 2\.1, February 1999/], ['LGPL-3.0.txt', /GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007/]]) {
		assert.match(read(`engine/licenses/${name}`), heading, `engine/licenses/${name} is the licence text`)
		assert.ok(read('web/tools/compose.mjs').includes(`['engine/licenses/${name}', '${name}']`), `compose ships ${name}`)
		assert.ok(read('engine/steelseed-host/tools/pack-node.mjs').includes(`'licenses/${name}', '${name}'`), `pack-node ships ${name}`)
		assert.ok(read('engine/steelseed-host/tools/pack-npm.mjs').includes(`'${name}'`), `pack-npm ships ${name}`)
		if (existsSync(join(root, 'desktop/shell-options.mjs'))) assert.ok(read('desktop/shell-options.mjs').includes(`'engine/licenses/${name}'`), `the desktop app ships ${name}`)
	}
})

test('the in-game credits open in a new tab and never navigate away from a match', () => {
	const html = read('web/index.html')
	const start = html.indexOf('<div class="copyright-body">')
	const body = html.slice(start, html.indexOf('</div>', start))
	for (const link of body.match(/<a [^>]+>/g) ?? [])
		assert.match(link, /target="_blank"/, `${link} opens in a new tab`)
})
