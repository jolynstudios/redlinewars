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
	write(join(steelseed, 'assets/sim.worker.js'), 'postMessage(42)\n')
	write(join(steelseed, 'index.html'), '<!doctype html><script type="module" src="assets/index.js"></script>\n')
	write(join(bundle, '_framework/dotnet.js'), 'export default {}\n')
	write(join(bundle, '_framework/dotnet.native.wasm'), 'wasm bytes')
	write(join(bundle, '_framework/blazor.boot.json'), '{"resources":{}}')
	write(join(bundle, '_framework/supportFiles/0_rules.yaml'), 'E1:\n\tHealth: 50\n')
	cpSync(join(checkout, 'engine/COPYING'), join(steelseed, 'licenses/COPYING-GPLv3.txt'))
	cpSync(join(checkout, 'engine/AUTHORS'), join(steelseed, 'licenses/AUTHORS-OpenRA.txt'))
	write(join(steelseed, 'licenses/THIRD-PARTY-NOTICES.txt'), NOTICES)
	for (const name of ['GPL-2.0.txt', 'LGPL-2.1.txt', 'LGPL-3.0.txt']) cpSync(join(checkout, 'engine/licenses', name), join(steelseed, 'licenses', name))
	// The reference: the candidate's own AppBundle as its build left it (before `change`).
	const reference = join(root, 'reference')
	const compose = dir => write(join(dir, 'steelseed/composition.json'), JSON.stringify({ schema: 1,
		files: walk(join(dir, 'steelseed')).filter(path => path !== 'composition.json').map(path => ({ path, sha256: sha256(join(dir, 'steelseed', path)) })) }))
	cpSync(bundle, reference, { recursive: true })
	compose(reference)
	change({ checkout, steelseed, bundle })
	compose(bundle)
	return { root, checkout, bundle, reference }
}

function verify({ checkout, bundle }, extra = []) {
	const run = spawnSync(process.execPath, [verifier, '--source', checkout, ...extra, bundle], { encoding: 'utf8' })
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

// --- --strict: an official release decision binds the bytes that run to the candidate's build. ---

test('--strict passes an AppBundle equal to its reference build', () => {
	const f = fixture()
	try {
		const { status, output } = verify(f, ['--strict', '--appbundle', f.reference])
		assert.equal(status, 0, output)
		assert.match(output, /runtime: 4 files \(WebAssembly, assemblies, boot config, generated rules, host scripts\) equal the reference/)
		assert.match(output, /claims: artifact integrity NOT_RUN; source correspondence PASS/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const [what, change, extra, pattern] of [
	['a missing reference build', () => {}, f => ['--strict'], /payload .*required check not executed/],
	['modified JS that keeps its old source map', ({ steelseed }) => write(join(steelseed, 'assets/index.js'), 'console.log(41)\n//# sourceMappingURL=index.js.map\n'),
		f => ['--strict', '--appbundle', f.reference], /composition\.json differs from the reference/],
	['a modified WebAssembly file', ({ bundle }) => write(join(bundle, '_framework/dotnet.native.wasm'), 'other wasm'),
		f => ['--strict', '--appbundle', f.reference], /runtime: 1 files missing or different .*dotnet\.native\.wasm/],
	['modified generated rules', ({ bundle }) => write(join(bundle, '_framework/supportFiles/0_rules.yaml'), 'E1:\n\tHealth: 5000\n'),
		f => ['--strict', '--appbundle', f.reference], /0_rules\.yaml/],
	['a missing worker', ({ steelseed }) => rmSync(join(steelseed, 'assets/sim.worker.js')),
		f => ['--strict', '--appbundle', f.reference], /composition\.json differs from the reference/],
	['an unlisted executable', ({ bundle }) => write(join(bundle, '_framework/extra.js'), 'fetch("x")\n'),
		f => ['--strict', '--appbundle', f.reference], /1 not in it \(extra\.js\)|not in it .*extra\.js/],
	['a stale build identity', ({ steelseed }) => write(join(steelseed, 'build.json'), JSON.stringify({ ...BUILD, simBuild: 'deadbeef0000' })),
		f => ['--strict', '--appbundle', f.reference], /simBuild deadbeef0000 .* ≠ checkout build/],
]) {
	test(`--strict refuses ${what}`, () => {
		const f = fixture(change)
		try {
			const { status, output } = verify(f, extra(f))
			assert.equal(status, 1, `expected a FAIL for ${what}:\n${output}`)
			assert.match(output, pattern)
		} finally { rmSync(f.root, { recursive: true, force: true }) }
	})
}

test('an option value is never read as an artifact, and an unknown option is a usage error', () => {
	const f = fixture()
	try {
		const ok = verify(f, ['--rebuild', f.reference, '--appbundle', f.reference])
		assert.equal(ok.status, 0, ok.output)
		assert.match(ok.output, /1 artifact\(s\)/)
		const bad = verify(f, ['--strcit'])
		assert.equal(bad.status, 2, bad.output)
		assert.match(bad.output, /unknown option --strcit/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

/** An Electron ASAR archive, as electron-builder lays it out. */
function writeAsar(file, entries) {
	const tree = { files: {} }, blobs = []
	let offset = 0
	for (const [path, data] of Object.entries(entries)) {
		const parts = path.split('/')
		let node = tree
		for (const dir of parts.slice(0, -1)) node = (node.files[dir] ??= { files: {} })
		node.files[parts.at(-1)] = { size: data.length, offset: String(offset) }
		offset += data.length
		blobs.push(Buffer.from(data))
	}
	const json = Buffer.from(JSON.stringify(tree)), padded = Math.ceil(json.length / 4) * 4
	const header = Buffer.alloc(8 + padded)
	header.writeUInt32LE(4 + padded, 0); header.writeUInt32LE(json.length, 4); json.copy(header, 8)
	const size = Buffer.alloc(8)
	size.writeUInt32LE(4, 0); size.writeUInt32LE(header.length, 4)
	write(file, Buffer.concat([size, header, ...blobs]))
}

/** A macOS desktop package built from the fixture's checkout; `change` edits its resources. */
function desktopFixture(change = () => {}) {
	const f = fixture()
	const { checkout } = f
	const shell = { 'main.mjs': 'import "./shell-options.mjs"\n', 'preload.cjs': 'module.exports = {}\n', 'shell-options.mjs': "export const LEGAL = 'Engine: OpenRA'\n", 'shell/landing.js': 'void 0\n' }
	write(join(checkout, 'desktop/package.mjs'), "export const SHELL_FILES = Object.freeze(['main.mjs', 'preload.cjs', 'shell-options.mjs', 'build/icon.png', 'shell/**']);\n")
	write(join(checkout, 'desktop/package.json'), JSON.stringify({ name: 'shell', version: '1.0.0', main: 'main.mjs', type: 'module', scripts: {} }))
	for (const [path, text] of Object.entries(shell)) write(join(checkout, 'desktop', path), text)
	write(join(checkout, 'engine/steelseed-host/tools/node.mjs'), 'export const node = 1\n')
	const app = join(f.root, 'pkg/Redline Wars.app'), resources = join(app, 'Contents/Resources')
	writeAsar(join(resources, 'app.asar'), { ...shell, 'build/icon.png': 'png', 'shell/bg.webp': 'art', 'package.json': JSON.stringify({ name: 'shell', version: '1.0.0', main: 'main.mjs', type: 'module' }) })
	cpSync(f.reference, join(resources, 'AppBundle'), { recursive: true })
	for (const [from, to] of [['engine/COPYING', 'COPYING-GPLv3.txt'], ['engine/AUTHORS', 'AUTHORS-OpenRA.txt'], ['engine/licenses/GPL-2.0.txt', 'GPL-2.0.txt'], ['engine/licenses/LGPL-2.1.txt', 'LGPL-2.1.txt'], ['engine/licenses/LGPL-3.0.txt', 'LGPL-3.0.txt']])
		cpSync(join(checkout, from), join(resources, 'legal', to))
	write(join(resources, 'legal/THIRD_PARTY_NOTICES.md'), NOTICES)
	const node = join(resources, 'steelseed-node')
	write(join(node, 'steelseed-host/tools/node.mjs'), 'export const node = 1\n')
	write(join(node, 'steelseed-host/generated/build.json'), JSON.stringify(BUILD))
	write(join(node, 'node-assembly.json'), JSON.stringify({ commit: 'a'.repeat(7), files: [{ path: 'steelseed-host/tools/node.mjs', sha256: sha256(join(node, 'steelseed-host/tools/node.mjs')) }] }))
	const name = 'Redline-Wars-macOS-arm64.zip'
	write(join(resources, 'RELEASE-MANIFEST.json'), JSON.stringify({ source: { commit: null, sourceCommit: 'a'.repeat(40), tag: 'v2026.09.26-aaaaaaa' }, build: { simBuild: BUILD.simBuild }, artifact: name }))
	change({ resources, shell })
	const zip = join(f.root, name)
	spawnSync('zip', ['-q', '-r', zip, 'Redline Wars.app'], { cwd: join(f.root, 'pkg') })
	write(join(f.root, 'SHA256SUMS'), `${sha256(zip)}  ${name}\n`)
	return { ...f, zip }
}

function verifyDesktop(f, extra = ['--strict']) {
	const run = spawnSync(process.execPath, [verifier, '--source', f.checkout, '--sums', join(f.root, 'SHA256SUMS'), '--appbundle', f.reference, ...extra, f.zip], { encoding: 'utf8' })
	return { status: run.status, output: run.stdout + run.stderr }
}

test('--strict passes a desktop package whose shell, payload, notices and manifest are the checkout\'s', () => {
	const f = desktopFixture()
	try {
		const { status, output } = verifyDesktop(f)
		assert.equal(status, 0, output)
		assert.match(output, /app\.asar: 4 shell scripts and pages byte-equal to the checkout; 2 brand image/)
		assert.match(output, /source correspondence PASS/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const [what, change, pattern] of [
	['a modified main process', ({ resources, shell }) => writeAsar(join(resources, 'app.asar'), { ...shell, 'main.mjs': 'import "./evil.mjs"\n', 'package.json': JSON.stringify({ name: 'shell', version: '1.0.0', main: 'main.mjs', type: 'module' }) }), /1 scripts differ from the checkout \(main\.mjs\)/],
	['a modified preload', ({ resources, shell }) => writeAsar(join(resources, 'app.asar'), { ...shell, 'preload.cjs': 'module.exports = { leak: 1 }\n', 'package.json': JSON.stringify({ name: 'shell', version: '1.0.0', main: 'main.mjs', type: 'module' }) }), /preload\.cjs/],
	['shell scripts checked out with CRLF', ({ resources, shell }) => writeAsar(join(resources, 'app.asar'), { ...Object.fromEntries(Object.entries(shell).map(([path, text]) => [path, text.replace(/\n/g, '\r\n')])), 'package.json': JSON.stringify({ name: 'shell', version: '1.0.0', main: 'main.mjs', type: 'module' }) }), /each only by CRLF line endings/],
	['an unlisted shell script', ({ resources, shell }) => writeAsar(join(resources, 'app.asar'), { ...shell, 'extra.mjs': 'void 1\n', 'package.json': JSON.stringify({ name: 'shell', version: '1.0.0', main: 'main.mjs', type: 'module' }) }), /1 unlisted \(extra\.mjs\)/],
	['an absent release manifest', ({ resources }) => rmSync(join(resources, 'RELEASE-MANIFEST.json')), /RELEASE-MANIFEST\.json missing/],
	['a manifest from another source', ({ resources }) => write(join(resources, 'RELEASE-MANIFEST.json'), JSON.stringify({ source: { commit: null, sourceCommit: 'b'.repeat(40), tag: 'v2026.09.26-bbbbbbb' }, build: { simBuild: BUILD.simBuild } })), /not this release's source/],
	['a wrong LGPL text', ({ resources }) => write(join(resources, 'legal/LGPL-3.0.txt'), 'not the licence\n'), /LGPL v3 text: differs/],
]) {
	test(`--strict refuses a desktop package with ${what}`, () => {
		const f = desktopFixture(change)
		try {
			const { status, output } = verifyDesktop(f)
			assert.equal(status, 1, `expected a FAIL for ${what}:\n${output}`)
			assert.match(output, pattern)
		} finally { rmSync(f.root, { recursive: true, force: true }) }
	})
}

test('--strict fails a package without its independent checksum record (required check not executed)', () => {
	const f = desktopFixture()
	try {
		const run = spawnSync(process.execPath, [verifier, '--source', f.checkout, '--appbundle', f.reference, '--strict', f.zip], { encoding: 'utf8' })
		assert.equal(run.status, 1, run.stdout)
		assert.match(run.stdout, /no independent record to check it against/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

