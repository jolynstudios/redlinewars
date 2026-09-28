// tools/verify-release.mjs can fail: a small AppBundle and the checkout it was built from pass,
// and each broken copy fails for its own reason.
//
//   node --test tools/verify-release.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
	write(join(checkout, 'engine/steelseed-host/tools/node-manifest.json'), JSON.stringify({ schema: 1, runtime: ['node.mjs'], data: ['generated'], modules: [], examples: ['rooms.example.json'] }))

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

test('a withheld-proprietary source in the maps is expected, and a published source still must be', () => {
	// Release binaries are built from the full tree, so their maps embed the withheld interface
	// too: RELEASE-SOURCE.json names it and the verifier counts it instead of failing on it.
	const f = fixture(({ steelseed }) => write(join(steelseed, 'assets/index.js.map'),
		JSON.stringify({ version: 3, sources: ['../../src/answer.ts', '../../src/hud/index.ts'],
			sourcesContent: [SOURCE_TS, 'export class Ui {}\n'], mappings: '' })))
	write(join(f.checkout, 'RELEASE-SOURCE.json'), JSON.stringify({ sourceCommit: 'a'.repeat(40), withheldPaths: ['web/src/hud/'] }))
	try {
		const { status, output } = verify(f)
		assert.equal(status, 0, output)
		assert.match(output, /1 web\/src files embedded in 1 source maps are byte-equal/)
		assert.match(output, /1 embedded withheld-proprietary sources/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a source that is neither published nor withheld is a failure', () => {
	const f = fixture(({ steelseed }) => write(join(steelseed, 'assets/index.js.map'),
		JSON.stringify({ version: 3, sources: ['../../src/answer.ts', '../../src/mystery.ts'],
			sourcesContent: [SOURCE_TS, 'export {}\n'], mappings: '' })))
	write(join(f.checkout, 'RELEASE-SOURCE.json'), JSON.stringify({ sourceCommit: 'a'.repeat(40), withheldPaths: ['web/src/hud/'] }))
	try {
		const { status, output } = verify(f)
		assert.equal(status, 1, 'expected a FAIL for an unaccounted source')
		assert.match(output, /1 missing \(web\/src\/mystery\.ts\)/)
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
	['a missing reference build', () => {}, f => ['--strict'], /payload .*required check produced no PASS \(NOT_RUN\)/],
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
	// desktop/package.mjs filters *.map out of the shipped AppBundle; the fixture mirrors the
	// packager, so its pass path exercises the reference-maps fallback.
	for (const map of readdirSync(join(resources, 'AppBundle/steelseed/assets')).filter(name => name.endsWith('.js.map')))
		rmSync(join(resources, 'AppBundle/steelseed/assets', map))
	for (const [from, to] of [['engine/COPYING', 'COPYING-GPLv3.txt'], ['engine/AUTHORS', 'AUTHORS-OpenRA.txt'], ['engine/licenses/GPL-2.0.txt', 'GPL-2.0.txt'], ['engine/licenses/LGPL-2.1.txt', 'LGPL-2.1.txt'], ['engine/licenses/LGPL-3.0.txt', 'LGPL-3.0.txt']])
		cpSync(join(checkout, from), join(resources, 'legal', to))
	write(join(resources, 'legal/THIRD_PARTY_NOTICES.md'), NOTICES)
	const node = join(resources, 'steelseed-node')
	write(join(node, 'steelseed-host/tools/node.mjs'), 'export const node = 1\n')
	write(join(node, 'steelseed-host/generated/build.json'), JSON.stringify(BUILD))
	// The complete inventory assemble-node.mjs would write: every manifest entry, generated included.
	write(join(node, 'node-assembly.json'), JSON.stringify({ commit: 'a'.repeat(7), rid: 'osx-arm64',
		files: ['steelseed-host/tools/node.mjs', 'steelseed-host/generated/build.json'].map(path => ({ path, sha256: sha256(join(node, path)) })) }))
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
		assert.match(output, /the artifact ships no source maps \(desktop filter\)/)
		assert.match(output, /source correspondence PASS/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('--strict refuses a desktop package that ships the source maps the release does not publish', () => {
	const f = desktopFixture(({ resources }) => {
		write(join(resources, 'AppBundle/steelseed/assets/index.js.map'), JSON.stringify({ version: 3, sources: ['../../src/answer.ts'], sourcesContent: [SOURCE_TS], mappings: '' }))
	})
	try {
		const { status, output } = verifyDesktop(f)
		assert.equal(status, 1, `expected a FAIL for a shipped source map:\n${output}`)
		assert.match(output, /the artifact ships 1 source map\(s\) the release does not publish/)
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

// --- node inventories (P0-A): the packaging's own definition decides what must be inventoried. ---

/** A checkout and a node artifact assembled from it in the real packaging's shape: node-assembly.json
 * lists every first-party file; the zip carries pack-node.mjs's launcher and licence set beside
 * them; the npm tgz carries pack-npm.mjs's set and no node_modules (npm installs ws).
 * `change` mutates the stage or checkout after the default assembly; `reassemble` rewrites the
 * inventory with corrected checksums (a tamperer who fixes the artifact's own record). */
function nodeFixture({ npm = false, built = true, installed = true, change = () => {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'verify-release-node-'))
	const checkout = join(root, 'checkout')
	write(join(checkout, 'RELEASE-SOURCE.json'), JSON.stringify({ sourceCommit: 'a'.repeat(40) }))
	cpSync(join(repo, 'LICENSE'), join(checkout, 'engine/COPYING'))
	write(join(checkout, 'engine/AUTHORS'), 'OpenRA authors\n')
	for (const name of ['GPL-2.0.txt', 'LGPL-2.1.txt', 'LGPL-3.0.txt']) cpSync(join(repo, 'licenses', name), join(checkout, 'engine/licenses', name))
	write(join(checkout, 'engine/steelseed-host/tools/node.mjs'), 'export const node = 1\n')
	write(join(checkout, 'engine/steelseed-host/tools/node-manifest.json'), JSON.stringify({ schema: 1, runtime: ['node.mjs'], data: ['generated'], modules: ['ws'], examples: ['rooms.example.json'] }))
	if (installed) write(join(checkout, 'engine/node_modules/ws/index.js'), 'export const ws = 1\n')
	if (built) write(join(checkout, 'engine/steelseed-host/generated/build.json'), JSON.stringify(BUILD))
	const stage = join(root, npm ? 'pkg/package' : 'redline-node-osx-arm64')
	write(join(stage, 'steelseed-host/tools/node.mjs'), 'export const node = 1\n')
	write(join(stage, 'steelseed-host/generated/build.json'), JSON.stringify(BUILD))
	if (!npm) write(join(stage, 'node_modules/ws/index.js'), 'export const ws = 1\n')
	// The npm package still inventories ws (assemble-node wrote the list before npm pack stripped
	// node_modules from the tarball): npm installs it as the declared dependency.
	const listed = ['steelseed-host/tools/node.mjs', 'steelseed-host/generated/build.json', 'node_modules/ws/index.js']
	const reassemble = () => write(join(stage, 'node-assembly.json'), JSON.stringify({ commit: 'a'.repeat(7), rid: 'osx-arm64',
		// npm strips node_modules from the tarball: the inventory keeps ws's checksum from the copy
		// the assembler staged (the checkout's identical source).
		files: listed.map(path => ({ path, sha256: sha256(existsSync(join(stage, path)) ? join(stage, path) : join(checkout, 'engine', path)) })) }))
	reassemble()
	const name = npm ? 'steelthorn-node-1.0.0.tgz' : 'redline-node-osx-arm64.zip'
	write(join(stage, 'RELEASE-MANIFEST.json'), JSON.stringify({ source: { commit: null, sourceCommit: 'a'.repeat(40), tag: 'v2026.09.26-aaaaaaa' }, build: { simBuild: BUILD.simBuild }, artifact: name }))
	write(join(stage, 'README-NODE.md'), '# node\n')
	write(join(stage, 'rooms.example.json'), '{}\n')
	if (npm) {
		write(join(stage, 'package.json'), JSON.stringify({ name: '@steelthorn/node', version: '1.0.0' }))
		write(join(stage, 'systemd/steelthorn-node.service'), '[Unit]\n')
		write(join(stage, 'systemd/steelthorn-spine.service'), '[Unit]\n')
		cpSync(join(checkout, 'engine/COPYING'), join(stage, 'COPYING'))
		cpSync(join(checkout, 'engine/AUTHORS'), join(stage, 'AUTHORS'))
	} else {
		write(join(stage, 'start-node.sh'), '#!/bin/sh\nexec node "$DIR/steelseed-host/tools/node-cli.mjs" "$@"\n')
		write(join(stage, 'steelthorn-node.service'), '[Unit]\n')
		cpSync(join(checkout, 'engine/COPYING'), join(stage, 'COPYING-GPLv3.txt'))
		cpSync(join(checkout, 'engine/AUTHORS'), join(stage, 'AUTHORS-OpenRA.txt'))
	}
	write(join(stage, 'THIRD-PARTY-NOTICES.txt'), NOTICES)
	for (const n of ['GPL-2.0.txt', 'LGPL-2.1.txt', 'LGPL-3.0.txt']) cpSync(join(checkout, 'engine/licenses', n), join(stage, n))
	change({ stage, checkout, reassemble })
	const artifact = join(root, name)
	if (npm) spawnSync('tar', ['-czf', artifact, '-C', join(root, 'pkg'), 'package'])
	else spawnSync('zip', ['-q', '-r', artifact, 'redline-node-osx-arm64'], { cwd: root })
	write(join(root, 'SHA256SUMS'), `${sha256(artifact)}  ${name}\n`)
	return { root, checkout, artifact, stage }
}

function verifyNode(f, extra = ['--strict']) {
	const run = spawnSync(process.execPath, [verifier, '--source', f.checkout, '--sums', join(f.root, 'SHA256SUMS'), ...extra, f.artifact], { encoding: 'utf8' })
	return { status: run.status, output: run.stdout + run.stderr }
}

test('a node zip assembled from its checkout passes strict', () => {
	const f = nodeFixture()
	try {
		const { status, output } = verifyNode(f)
		assert.equal(status, 0, output)
		assert.match(output, /3\/3 required first-party node files inventoried and shipped, node sources byte-equal to the checkout/)
		assert.match(output, /no unlisted payloads: every shipped file is inventoried or declared packaging metadata/)
		assert.match(output, /source correspondence PASS/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an npm node package passes strict (ws installs as its declared dependency)', () => {
	const f = nodeFixture({ npm: true })
	try {
		const { status, output } = verifyNode(f)
		assert.equal(status, 0, output)
		assert.match(output, /1 node_modules files are installed by npm from the package's dependencies/)
		assert.match(output, /2\/2 required first-party node files inventoried and shipped/)
		assert.match(output, /no unlisted payloads/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const [what, fixtureOptions, pattern] of [
	['an empty inventory', { change: ({ stage }) => write(join(stage, 'node-assembly.json'), JSON.stringify({ commit: 'a'.repeat(7), rid: 'osx-arm64', files: [] })) },
		/node-assembly\.json: "files" is empty: no first-party file is inventoried at all/],
	['no inventory key', { change: ({ stage }) => write(join(stage, 'node-assembly.json'), JSON.stringify({ commit: 'a'.repeat(7), rid: 'osx-arm64' })) },
		/node-assembly\.json: "files" is not an array/],
	['a non-array inventory', { change: ({ stage }) => write(join(stage, 'node-assembly.json'), JSON.stringify({ commit: 'a'.repeat(7), rid: 'osx-arm64', files: 'all of them' })) },
		/node-assembly\.json: "files" is not an array/],
	['an entry without a digest', { change: ({ stage }) => write(join(stage, 'node-assembly.json'), JSON.stringify({ commit: 'a'.repeat(7), rid: 'osx-arm64', files: [{ path: 'steelseed-host/tools/node.mjs' }] })) },
		/sha256 is missing or not a 64-hex digest/],
	['a notices-only inventory', { change: ({ stage, reassemble }) => { reassemble(); write(join(stage, 'node-assembly.json'), JSON.stringify({ commit: 'a'.repeat(7), rid: 'osx-arm64', files: [{ path: 'THIRD-PARTY-NOTICES.txt', sha256: sha256(join(stage, 'THIRD-PARTY-NOTICES.txt')) }] })) } },
		/3 of 3 required first-party node files \(from node-manifest\.json\) are not inventoried and shipped: steelseed-host\/tools\/node\.mjs/],
	['a required node source left out of the inventory', { change: ({ stage }) => write(join(stage, 'node-assembly.json'), JSON.stringify({ commit: 'a'.repeat(7), rid: 'osx-arm64', files: ['steelseed-host/generated/build.json', 'node_modules/ws/index.js'].map(path => ({ path, sha256: sha256(join(stage, path)) })) })) },
		/1 of 3 required first-party node files .*not inventoried and shipped: steelseed-host\/tools\/node\.mjs/],
	['an inventoried file missing from the package', { change: ({ stage }) => rmSync(join(stage, 'node_modules/ws/index.js')) },
		/1 shipped files differ from node-assembly\.json: node_modules\/ws\/index\.js/],
	['a packaged source that differs from the checkout, its own inventory corrected', { change: ({ stage, reassemble }) => { write(join(stage, 'steelseed-host/tools/node.mjs'), 'export const node = 2\n'); reassemble() } },
		/node sources differ from the checkout: steelseed-host\/tools\/node\.mjs/],
	['an unlisted executable payload', { change: ({ stage }) => write(join(stage, 'extra.mjs'), 'fetch("https://evil.example")\n') },
		/unlisted payloads the node's packaging never places: extra\.mjs/],
	['a node-assembly from another source', { change: ({ stage, reassemble }) => { write(join(stage, 'node-assembly.json'), JSON.stringify({ commit: 'b'.repeat(7), rid: 'osx-arm64', files: JSON.parse(readFileSync(join(stage, 'node-assembly.json'), 'utf8')).files })) } },
		/is neither the release source/],
	['a malformed commit', { change: ({ stage }) => write(join(stage, 'node-assembly.json'), JSON.stringify({ commit: 'not-a-commit', rid: 'osx-arm64', files: [{ path: 'steelseed-host/tools/node.mjs', sha256: sha256(join(stage, 'steelseed-host/tools/node.mjs')) }] })) },
		/node-assembly commit is malformed/],
]) {
	test(`strict refuses a node zip with ${what}`, () => {
		const f = nodeFixture(fixtureOptions)
		try {
			const { status, output } = verifyNode(f)
			assert.equal(status, 1, `expected a FAIL for ${what}:\n${output}`)
			assert.match(output, pattern)
		} finally { rmSync(f.root, { recursive: true, force: true }) }
	})
}

// --- simulation-build identity (P0-B): no subject speaks for another, and a gap is never a pass. ---

test('strict refuses a matching source commit when the checkout is not built (the sim comparison never ran)', () => {
	const f = nodeFixture({ built: false })
	try {
		const { status, output } = verifyNode(f)
		assert.equal(status, 1, `expected a FAIL:\n${output}`)
		assert.match(output, /FAIL\s+sim-build-identity\s+node generated\/build\.json: simBuild c0ffee000000 \(checkout not built; run tools\/build\.mjs to compare\) \(a gap fails --strict\)/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('audit mode reports the unbuilt checkout as a gap, without a false source-correspondence pass', () => {
	const f = nodeFixture({ built: false })
	try {
		const { status, output } = verifyNode(f, [])
		assert.equal(status, 0, output)
		assert.match(output, /GAP\s+sim-build-identity\s+node generated\/build\.json: simBuild c0ffee000000 \(checkout not built; run tools\/build\.mjs to compare\)/)
		assert.match(output, /source correspondence NOT_RUN/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('audit mode reports uninstalled npm modules as a gap (node_modules is build output, never tracked)', () => {
	const f = nodeFixture({ installed: false })
	try {
		const { status, output } = verifyNode(f, [])
		assert.equal(status, 0, output)
		assert.match(output, /GAP\s+node\s+the checkout has no engine\/node_modules: ws cannot be derived/)
		assert.doesNotMatch(output, /node-manifest\.json lists files the checkout does not have/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const [what, change, pattern] of [
	['a modHash that differs from the checkout', ({ steelseed }) => write(join(steelseed, 'build.json'), JSON.stringify({ ...BUILD, modHash: 'e'.repeat(64) })),
		/modHash eeeeeeeeeeee ≠ checkout build/],
	['build metadata without its required fields', ({ steelseed }) => write(join(steelseed, 'build.json'), JSON.stringify({ schema: 1 })),
		/AppBundle build\.json: build\.json is malformed \(simBuild and a 64-hex modHash are required\)/],
]) {
	test(`strict refuses an AppBundle with ${what}`, () => {
		const f = fixture(change)
		try {
			const { status, output } = verify(f, ['--strict', '--appbundle', f.reference])
			assert.equal(status, 1, `expected a FAIL for ${what}:\n${output}`)
			assert.match(output, pattern)
		} finally { rmSync(f.root, { recursive: true, force: true }) }
	})
}

test('strict refuses a desktop package whose AppBundle build.json is missing (a passing node build never speaks for it)', () => {
	const f = desktopFixture(({ resources }) => rmSync(join(resources, 'AppBundle/steelseed/build.json')))
	try {
		const { status, output } = verifyDesktop(f)
		assert.equal(status, 1, `expected a FAIL:\n${output}`)
		assert.match(output, /FAIL\s+sim-build-identity\s+AppBundle build\.json: build\.json missing/)
	} finally { rmSync(f.root, { recursive: true, force: true }) }
})

