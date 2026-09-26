#!/usr/bin/env node
// Redline Wars — check distributed artifacts against their public source.
//
//   node tools/verify-release.mjs --source <checkout> [--strict] [--sums <SHA256SUMS>] [--require-manifest]
//                                 [--appbundle <dir>] [--rebuild <dir>] [--platform-report <json>]
//                                 [--json <report.json>] <artifact | URL>...
//
// <checkout> is this repository at the artifact's source tag, built with tools/build.mjs (the
// generated mod, ws and the standalone server are compared against its outputs when present).
// An artifact is a node zip (redline-node-<rid>.zip), a desktop package (Redline-Wars-*.zip, *.exe,
// *.AppImage; the installers need 7-Zip's `7zz` or `7z`), an npm node package (*.tgz), an AppBundle
// directory, or the URL of a live AppBundle's steelseed/ directory. A live site that does not serve
// its source maps is checked through --appbundle, the build's own AppBundle: its composition.json
// must equal the live one, every served script must match that composition, and the maps are then
// taken from the AppBundle, each checked against the composition's hash.
//
// Checks, each FAIL making the exit code 1:
//   integrity   the artifact's sha256 against its SHA256SUMS line (--sums)
//   identity    node-assembly.json's commit against RELEASE-SOURCE.json's sourceCommit, and every
//               shipped build.json's simBuild and modHash against the checkout's built mod
//   node        every node source file (steelseed-host/tools) byte-equal to the checkout; the
//               generated mod and ws compared with the checkout's build; the compiled standalone
//               server listed (a .NET build is not byte-reproducible across machines)
//   client      every file of web/src embedded in the shipped source maps byte-equal to the
//               checkout (the art packs under .forge/ are separately licensed and skipped); a
//               build with no map, or a map without its sources' content, fails
//   notices     the GPL text, OpenRA's AUTHORS and the licences of the bundled libraries (GPL v2,
//               LGPL v2.1, LGPL v3) are in the artifact and byte-equal to the checkout's; the
//               third-party notices are in it and credit what the build bundles
//   framework   with --appbundle, every WebAssembly runtime file the live site serves
//               (_framework/) equals the build's own
//   manifest    RELEASE-MANIFEST.json names this source (reported; FAIL with --require-manifest)
//   boundary    a server artifact carries no WebGPU client; a desktop package carries the AppBundle
//   payload     with --appbundle (the candidate's own AppBundle, e.g. the deploy run's artifact): the
//               artifact's composition.json equals it, every listed file is present and equal, no file
//               is unlisted, and the runtime beside it (_framework/: WebAssembly, assemblies, boot
//               config, the generated rules; the host scripts) equals it file by file. Source maps
//               alone do not prove what a payload was built from; this binds the bytes that run.
//   shell       a desktop package's app.asar: every shipped shell script and page (desktop/package.mjs
//               SHELL_FILES) byte-equal to the checkout, package.json's name/version/main/type equal,
//               no unlisted script; the images and fonts beside them are brand art, counted only
//   rebuild     with --rebuild <AppBundle built from this checkout>: its program files against the
//               candidate's (reported; the official client embeds separately licensed art, so a
//               public rebuild is not expected to be byte-equal and the check is not required)
//   platform    with --platform-report <json>: a recorded run of the packaged app (e.g. its --selftest
//               on a named OS and architecture); the verifier itself runs nothing
//
// --strict is the check an official release decision uses. It adds, per artifact kind, the checks
// that must PASS (see REQUIRED): a file needs its independent SHA256SUMS line; a desktop package,
// an AppBundle and the live site need --appbundle; every package needs its RELEASE-MANIFEST.json.
// A required check that did not run fails; INFO, GAP and NOT_RUN never count as a pass. Without
// --strict the tool audits (older artifacts included) and says what it could not establish.
//
// The summary groups the checks into five separate claims: artifact integrity (bytes against an
// independent record), source correspondence (what runs, tied to this source), rebuild evidence,
// notices, and platform execution.
//
// Exit: 0 PASS, 1 FAIL, 2 usage error.

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

// Options that take a value, and flags; an option's value is never read as an artifact.
const VALUE_OPTIONS = ['--source', '--sums', '--json', '--appbundle', '--rebuild', '--platform-report']
const FLAG_OPTIONS = ['--require-manifest', '--strict']
const args = process.argv.slice(2), options = new Map(), targets = [], usageErrors = []
for (let i = 0; i < args.length; i++) {
	const arg = args[i]
	if (VALUE_OPTIONS.includes(arg)) {
		if (i + 1 >= args.length || args[i + 1].startsWith('--')) usageErrors.push(`${arg} needs a value`)
		else options.set(arg, args[++i])
	} else if (FLAG_OPTIONS.includes(arg)) options.set(arg, true)
	else if (arg.startsWith('--')) usageErrors.push(`unknown option ${arg}`)
	else targets.push(arg)
}
const option = name => options.get(`--${name}`) ?? null
const SOURCE = option('source') && resolve(option('source'))
const STRICT = options.has('--strict')
const SUMS = option('sums'), JSON_OUT = option('json'), REQUIRE_MANIFEST = STRICT || options.has('--require-manifest')
const APPBUNDLE = option('appbundle') && resolve(option('appbundle'))
const REBUILD = option('rebuild') && resolve(option('rebuild'))
const PLATFORM_REPORT = option('platform-report') && resolve(option('platform-report'))
if (usageErrors.length || !SOURCE || !targets.length) {
	for (const error of usageErrors) console.error(`verify-release: ${error}`)
	console.error('usage: node tools/verify-release.mjs --source <checkout> [--strict] [--sums <SHA256SUMS>] [--require-manifest] [--appbundle <dir>] [--rebuild <dir>] [--platform-report <json>] [--json <file>] <artifact | URL>...')
	process.exit(2)
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256File = file => sha256(readFileSync(file))
function sha256Stream(file) {
	// Installers are hundreds of MB: hash in chunks.
	const hash = createHash('sha256'), fd = openSync(file, 'r'), chunk = Buffer.alloc(8 << 20)
	try {
		for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n))
	} finally {
		closeSync(fd)
	}
	return hash.digest('hex')
}
function walk(dir, base = dir, found = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name), stat = statSync(path)
		if (stat.isDirectory()) walk(path, base, found)
		else found.push(path.slice(base.length + 1))
	}
	return found
}
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

const releaseSource = existsSync(join(SOURCE, 'RELEASE-SOURCE.json')) ? readJson(join(SOURCE, 'RELEASE-SOURCE.json')) : null
// An official build records the private commit this tree was exported from; a build of this
// repository records the checkout's own commit.
const checkoutCommit = (() => {
	try { return execFileSync('git', ['-C', SOURCE, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
})()
const checkoutTag = (() => {
	try { return execFileSync('git', ['-C', SOURCE, 'describe', '--tags', '--exact-match', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
})()
const builtMod = existsSync(join(SOURCE, 'engine/steelseed-host/generated/build.json'))
	? readJson(join(SOURCE, 'engine/steelseed-host/generated/build.json')) : null
const sums = new Map()
if (SUMS) for (const line of readFileSync(SUMS, 'utf8').split('\n')) {
	const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/)
	if (m) sums.set(m[2].trim(), m[1])
}

// ---------------------------------------------------------------------------------------------

function report(name) {
	const checks = []
	const add = (check, status, detail) => checks.push({ check, status, detail })
	return { name, checks, add }
}

function sevenZip() {
	for (const bin of ['7zz', '7z']) if (spawnSync(bin, ['i'], { stdio: 'ignore' }).status === 0) return bin
	throw new Error('extracting an installer needs 7-Zip (7zz or 7z) on PATH')
}

/** Unpacks an artifact; returns { kind, nodeRoot, appBundle, legal: [{label, file}], manifest }. */
function unpack(file, into) {
	const name = basename(file)
	if (/^redline-node-.+\.zip$/.test(name)) {
		execFileSync('unzip', ['-q', '-o', file, '-d', into])
		const root = join(into, readdirSync(into).find(entry => entry.startsWith('redline-node-')))
		return { kind: 'node-zip', nodeRoot: root, appBundle: null, scanRoot: root,
			legal: [['GPL text', 'COPYING-GPLv3.txt'], ['OpenRA AUTHORS', 'AUTHORS-OpenRA.txt'], ['third-party notices', 'THIRD-PARTY-NOTICES.txt'], ['GPL v2 text', 'GPL-2.0.txt'], ['LGPL v2.1 text', 'LGPL-2.1.txt'], ['LGPL v3 text', 'LGPL-3.0.txt']]
				.map(([label, rel]) => ({ label, file: join(root, rel) })),
			manifest: join(root, 'RELEASE-MANIFEST.json') }
	}
	if (name.endsWith('.tgz')) {
		execFileSync('tar', ['-xzf', file, '-C', into])
		const root = join(into, 'package')
		return { kind: 'npm-node', nodeRoot: root, appBundle: null, scanRoot: root,
			legal: [['GPL text', 'COPYING'], ['OpenRA AUTHORS', 'AUTHORS'], ['third-party notices', 'THIRD-PARTY-NOTICES.txt'], ['GPL v2 text', 'GPL-2.0.txt'], ['LGPL v2.1 text', 'LGPL-2.1.txt'], ['LGPL v3 text', 'LGPL-3.0.txt']]
				.map(([label, rel]) => ({ label, file: join(root, rel) })),
			manifest: join(root, 'RELEASE-MANIFEST.json') }
	}
	let resources
	if (name.endsWith('.zip')) {
		execFileSync('unzip', ['-q', '-o', file, '-d', into])
		const app = readdirSync(into).find(entry => entry.endsWith('.app'))
		resources = join(into, app, 'Contents/Resources')
	} else if (name.endsWith('.exe')) {
		const bin = sevenZip()
		execFileSync(bin, ['x', '-y', `-o${join(into, 'nsis')}`, file, '$PLUGINSDIR/app-64.7z'], { stdio: 'ignore' })
		execFileSync(bin, ['x', '-y', `-o${join(into, 'app')}`, join(into, 'nsis/$PLUGINSDIR/app-64.7z')], { stdio: 'ignore' })
		resources = join(into, 'app/resources')
	} else if (name.endsWith('.AppImage')) {
		// 7-Zip reads the squashfs image; it may exit non-zero on the ELF runtime in front of it.
		spawnSync(sevenZip(), ['x', '-y', `-o${join(into, 'app')}`, file], { stdio: 'ignore' })
		resources = join(into, 'app/resources')
	} else throw new Error(`unknown artifact type: ${name}`)
	if (!existsSync(resources)) throw new Error(`${name}: no resources directory after extraction`)
	return { kind: 'desktop', resources, nodeRoot: join(resources, 'steelseed-node'), appBundle: join(resources, 'AppBundle'), scanRoot: resources,
		legal: [['GPL text', 'legal/COPYING-GPLv3.txt'], ['OpenRA AUTHORS', 'legal/AUTHORS-OpenRA.txt'], ['third-party notices', 'legal/THIRD_PARTY_NOTICES.md'],
			['GPL v2 text', 'legal/GPL-2.0.txt'], ['LGPL v2.1 text', 'legal/LGPL-2.1.txt'], ['LGPL v3 text', 'legal/LGPL-3.0.txt'],
			['AppBundle GPL text', 'AppBundle/steelseed/licenses/COPYING-GPLv3.txt'], ['AppBundle third-party notices', 'AppBundle/steelseed/licenses/THIRD-PARTY-NOTICES.txt'],
			['AppBundle GPL v2 text', 'AppBundle/steelseed/licenses/GPL-2.0.txt'], ['AppBundle LGPL v2.1 text', 'AppBundle/steelseed/licenses/LGPL-2.1.txt'],
			['AppBundle LGPL v3 text', 'AppBundle/steelseed/licenses/LGPL-3.0.txt']]
			.map(([label, rel]) => ({ label, file: join(resources, rel) })),
		manifest: join(resources, 'RELEASE-MANIFEST.json') }
}

// ---------------------------------------------------------------------------------------------

function checkIdentity(r, commit, builds) {
	if (!releaseSource) r.add('identity', 'FAIL', 'the checkout has no RELEASE-SOURCE.json (check out a release tag)')
	else if (commit != null) {
		const official = commit.length >= 7 && releaseSource.sourceCommit.startsWith(commit)
		const public_ = commit.length >= 7 && checkoutCommit?.startsWith(commit)
		r.add('identity', official || public_ ? 'PASS' : 'FAIL', official ? `node-assembly commit ${commit} = release source ${releaseSource.sourceCommit.slice(0, 12)}`
			: public_ ? `node-assembly commit ${commit} = this checkout (${checkoutCommit.slice(0, 12)})`
			: `node-assembly commit ${commit} is neither the release source ${releaseSource.sourceCommit.slice(0, 12)} nor this checkout ${checkoutCommit?.slice(0, 12) ?? '(not a git checkout)'}`)
	}
	for (const [label, build] of builds) {
		if (!build) { r.add('identity', 'FAIL', `${label}: build.json missing`); continue }
		if (!builtMod) { r.add('identity', 'INFO', `${label}: simBuild ${build.simBuild} (checkout not built; run tools/build.mjs to compare)`); continue }
		const ok = build.simBuild === builtMod.simBuild && build.modHash === builtMod.modHash
		r.add('identity', ok ? 'PASS' : 'FAIL', `${label}: simBuild ${build.simBuild} modHash ${build.modHash?.slice(0, 12)} ${ok ? '=' : '≠'} checkout build ${builtMod.simBuild} ${builtMod.modHash.slice(0, 12)}`)
	}
}

function checkNode(r, nodeRoot, kind) {
	const assemblyFile = join(nodeRoot, 'node-assembly.json')
	if (!existsSync(assemblyFile)) { r.add('node', 'FAIL', 'node-assembly.json missing'); return null }
	const assembly = readJson(assemblyFile)
	const tally = {}
	const count = (group, outcome) => { tally[group] ??= {}; tally[group][outcome] = (tally[group][outcome] ?? 0) + 1 }
	const sourceMismatch = [], shippedMismatch = []
	// npm strips node_modules/ from a package tarball: ws is installed as its declared dependency.
	const installed = kind === 'npm-node' ? assembly.files.filter(f => f.path.startsWith('node_modules/')).length : 0
	if (installed) r.add('node', 'INFO', `${installed} node_modules files are installed by npm from the package's dependencies, not shipped`)
	for (const { path, sha256: listed } of assembly.files) {
		if (kind === 'npm-node' && path.startsWith('node_modules/')) continue
		const shipped = join(nodeRoot, path)
		if (!existsSync(shipped) || sha256File(shipped) !== listed) { shippedMismatch.push(path); continue }
		const group = path.startsWith('steelseed-host/tools/') ? 'source' : path.startsWith('steelseed-host/generated/') ? 'generated mod'
			: path.startsWith('node_modules/') ? 'npm modules' : path.startsWith('bin-standalone/') ? 'standalone server' : 'other'
		const checkout = join(SOURCE, 'engine', path)
		if (!existsSync(checkout)) { count(group, 'not in checkout'); if (group === 'source') sourceMismatch.push(`${path} (missing)`); continue }
		const same = sha256File(checkout) === listed
		count(group, same ? 'equal' : 'different')
		if (group === 'source' && !same) sourceMismatch.push(path)
	}
	r.add('node', shippedMismatch.length ? 'FAIL' : 'PASS', shippedMismatch.length
		? `${shippedMismatch.length} shipped files differ from node-assembly.json: ${shippedMismatch.slice(0, 5).join(', ')}`
		: `${assembly.files.length - installed} shipped files match node-assembly.json`)
	r.add('node', sourceMismatch.length ? 'FAIL' : 'PASS', sourceMismatch.length
		? `node sources differ from the checkout: ${sourceMismatch.slice(0, 8).join(', ')}`
		: `${tally.source?.equal ?? 0} node source files byte-equal to the checkout`)
	for (const group of ['generated mod', 'npm modules', 'standalone server'])
		if (tally[group]) r.add('node', 'INFO', `${group}: ${Object.entries(tally[group]).map(([k, v]) => `${v} ${k}`).join(', ')}`)
	return assembly
}

function checkMaps(r, maps) {
	// maps: [{ name, json }]; sources are relative to web/dist/assets (or dist/ for workers).
	let equal = 0, art = 0
	const different = [], missing = [], other = [], unreadable = []
	const seen = new Set()
	for (const { name, json } of maps) json.sources.forEach((source, i) => {
		const content = json.sourcesContent?.[i]
		const at = source.indexOf('src/'), forge = source.includes('.forge/')
		if (forge) { art++; return }
		if (at < 0 || !/^(?:\.\.\/)+src\//.test(source.slice(0, at + 4))) { other.push(`${name}: ${source}`); return }
		const rel = `web/${source.slice(at)}`
		if (seen.has(rel)) return
		seen.add(rel)
		const file = join(SOURCE, rel)
		if (!existsSync(file)) { missing.push(rel); return }
		if (content == null) { unreadable.push(rel); return }
		if (readFileSync(file, 'utf8') === content) equal++
		else different.push(rel)
	})
	const bad = different.length + missing.length + unreadable.length
	if (!maps.length || (!bad && !equal)) {
		r.add('client', 'FAIL', maps.length ? `${maps.length} source maps embed no web/src file: nothing ties the client to this source`
			: 'no source maps: nothing ties the client to this source')
		return
	}
	r.add('client', bad ? 'FAIL' : 'PASS', bad
		? `${different.length} web/src files differ (${different.slice(0, 6).join(', ')}), ${missing.length} missing (${missing.slice(0, 6).join(', ')}), ${unreadable.length} without embedded content (${unreadable.slice(0, 6).join(', ')})`
		: `${equal} web/src files embedded in ${maps.length} source maps are byte-equal to the checkout`)
	if (art) r.add('client', 'INFO', `${art} embedded art-pack modules (.forge/, separately licensed) not compared`)
	if (other.length) r.add('client', 'INFO', `${other.length} other embedded sources: ${other.slice(0, 4).join(', ')}`)
}

/** The checkout's text each shipped licence must equal, by the label's kind. */
const REFERENCE_TEXTS = [
	[/GPL v2 text$/, 'engine/licenses/GPL-2.0.txt'], [/LGPL v2\.1 text$/, 'engine/licenses/LGPL-2.1.txt'], [/LGPL v3 text$/, 'engine/licenses/LGPL-3.0.txt'],
	[/GPL text$/, 'engine/COPYING'], [/OpenRA AUTHORS$/, 'engine/AUTHORS'],
]
/** What the shipped third-party notices must credit: the engine, and every library licence shipped. */
const NOTICE_CREDITS = ['The OpenRA Developers and Contributors', 'GNU GPL v3 or later', 'MP3Sharp', 'TagLib', 'FuzzyLogicLibrary', 'SIL Open Font License']

function checkLegalText(r, label, text) {
	if (text == null) { r.add('notices', 'FAIL', `${label}: missing`); return }
	const kind = label.replace(/ \(served\)$/, '')
	if (/third-party notices$/.test(kind)) {
		const absent = NOTICE_CREDITS.filter(credit => !text.toString('utf8').includes(credit))
		r.add('notices', absent.length ? 'FAIL' : 'PASS', absent.length ? `${label}: does not credit ${absent.join(', ')}` : `${label}: present, credits the engine and its libraries`)
		return
	}
	const reference = REFERENCE_TEXTS.find(([pattern]) => pattern.test(kind))?.[1]
	if (!reference) { r.add('notices', text.length ? 'PASS' : 'FAIL', `${label}: ${text.length ? 'present' : 'empty'}`); return }
	if (!existsSync(join(SOURCE, reference))) { r.add('notices', 'FAIL', `${label}: the checkout has no ${reference} to compare with`); return }
	const same = readFileSync(join(SOURCE, reference)).equals(text)
	r.add('notices', same ? 'PASS' : 'FAIL', `${label}: ${same ? `equal to ${reference}` : `differs from ${reference}`}`)
}

function checkLegal(r, legal) {
	for (const { label, file } of legal) checkLegalText(r, label, existsSync(file) ? readFileSync(file) : null)
}

function checkManifest(r, file, artifactName) {
	if (!existsSync(file)) { r.add('manifest', REQUIRE_MANIFEST ? 'FAIL' : 'GAP', 'RELEASE-MANIFEST.json missing (artifacts packaged before the manifest existed)'); return }
	const manifest = readJson(file)
	const problems = []
	if (releaseSource && manifest.source?.sourceCommit && manifest.source.sourceCommit !== releaseSource.sourceCommit) problems.push('source commit')
	// The official build runs in the private repository: it names the public tag and its source
	// commit, and no public commit. A build of this repository names the checkout's commit.
	const official = manifest.source?.commit == null && manifest.source?.sourceCommit != null
	if (official) {
		if (!releaseSource || manifest.source.sourceCommit !== releaseSource.sourceCommit) problems.push(`official build of ${manifest.source.sourceCommit.slice(0, 12)}, not this release's source`)
		if (checkoutTag && manifest.source.tag !== checkoutTag) problems.push(`names tag ${manifest.source.tag}, not ${checkoutTag}`)
	} else if (checkoutCommit && manifest.source?.commit !== checkoutCommit) problems.push(`built from ${manifest.source?.commit?.slice(0, 12)}, not this checkout`)
	if (manifest.source?.dirty) problems.push('built with local changes')
	if (!manifest.source?.tag) problems.push('no source tag')
	if (builtMod && manifest.build?.simBuild !== builtMod.simBuild) problems.push('simBuild')
	if (artifactName && manifest.artifact && manifest.artifact !== artifactName) problems.push(`artifact name ${manifest.artifact}`)
	r.add('manifest', problems.length ? 'FAIL' : 'PASS', problems.length ? `RELEASE-MANIFEST.json: ${problems.join(', ')}`
		: `RELEASE-MANIFEST.json: tag ${manifest.source.tag}, simBuild ${manifest.build?.simBuild}`)
}

function checkBoundary(r, kind, scanRoot, appBundle) {
	const files = walk(scanRoot)
	if (kind === 'desktop') {
		const ok = existsSync(join(appBundle, 'steelseed/index.html')) && existsSync(join(appBundle, '_framework/dotnet.js'))
		r.add('boundary', ok ? 'PASS' : 'FAIL', ok ? 'desktop package carries the AppBundle (client and WebAssembly engine)' : 'AppBundle incomplete')
	} else {
		const client = files.filter(path => /(?:^|\/)AppBundle\/|\.wasm$|(?:^|\/)steelseed\/assets\//.test(path))
		r.add('boundary', client.length ? 'FAIL' : 'PASS', client.length ? `server artifact carries client files: ${client.slice(0, 4).join(', ')}`
			: `server artifact carries no WebGPU client or WebAssembly (${files.length} files)`)
	}
}

/** An Electron ASAR archive as { path: Buffer } (its unpacked files, if any, beside it). */
export function readAsar(file) {
	const bytes = readFileSync(file)
	const headerSize = bytes.readUInt32LE(4), header = bytes.subarray(8, 8 + headerSize)
	const json = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString('utf8'))
	const base = 8 + headerSize, files = new Map()
	const visit = (node, prefix) => {
		for (const [name, entry] of Object.entries(node.files ?? {})) {
			const path = prefix ? `${prefix}/${name}` : name
			if (entry.files) visit(entry, path)
			else if (entry.unpacked) { const beside = join(`${file}.unpacked`, path); files.set(path, existsSync(beside) ? readFileSync(beside) : null) }
			else files.set(path, bytes.subarray(base + Number(entry.offset), base + Number(entry.offset) + entry.size))
		}
	}
	visit(json, '')
	return files
}

/** The shell's shipped files, as desktop/package.mjs declares them (its SHELL_FILES). */
function shellFiles() {
	const text = existsSync(join(SOURCE, 'desktop/package.mjs')) ? readFileSync(join(SOURCE, 'desktop/package.mjs'), 'utf8') : ''
	// SHELL_FILES since the release-readiness work; before it, the same list inline in targetConfig.
	const list = /SHELL_FILES = Object\.freeze\(\[([^\]]*)\]\)/.exec(text)?.[1] ?? /\bfiles: \[('main\.mjs'[^\]]*)\]/.exec(text)?.[1]
	return list ? [...list.matchAll(/'([^']+)'/g)].map(m => m[1]) : null
}

function checkShell(r, resources) {
	const asar = join(resources, 'app.asar')
	if (!existsSync(asar)) { r.add('shell', 'FAIL', 'app.asar missing'); return }
	const declared = shellFiles()
	if (!declared) { r.add('shell', 'FAIL', 'the checkout has no desktop/package.mjs SHELL_FILES to compare with'); return }
	const shipped = readAsar(asar)
	const isScript = path => /\.(mjs|cjs|js|html)$/.test(path)
	const expected = new Set()
	for (const entry of declared) {
		if (!entry.endsWith('/**')) { expected.add(entry); continue }
		const dir = entry.slice(0, -3)
		for (const path of shipped.keys()) if (path.startsWith(`${dir}/`)) expected.add(path)
		for (const rel of existsSync(join(SOURCE, 'desktop', dir)) ? walk(join(SOURCE, 'desktop', dir)) : []) if (isScript(rel)) expected.add(`${dir}/${rel}`)
	}
	const differ = [], missing = [], unlisted = [], lineEndings = []
	let equal = 0, art = 0
	for (const path of expected) {
		if (!isScript(path)) { if (shipped.has(path)) art++; continue }
		const bytes = shipped.get(path), checkout = join(SOURCE, 'desktop', path)
		if (!bytes) { missing.push(path); continue }
		if (!existsSync(checkout) || !readFileSync(checkout).equals(bytes)) {
			differ.push(path)
			// Named, not excused: a checkout that converted LF to CRLF still ships other bytes.
			if (existsSync(checkout) && Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1').equals(readFileSync(checkout))) lineEndings.push(path)
		} else equal++
	}
	for (const path of shipped.keys()) if (isScript(path) && !expected.has(path)) unlisted.push(path)
	const bad = differ.length + missing.length + unlisted.length
	r.add('shell', bad ? 'FAIL' : equal ? 'PASS' : 'FAIL', bad
		? `app.asar: ${differ.length} scripts differ from the checkout (${differ.join(', ')}${lineEndings.length === differ.length && differ.length ? '; each only by CRLF line endings: the build checked the source out with CRLF' : lineEndings.length ? `; ${lineEndings.length} only by CRLF line endings` : ''}), ${missing.length} missing (${missing.join(', ')}), ${unlisted.length} unlisted (${unlisted.join(', ')})`
		: `app.asar: ${equal} shell scripts and pages byte-equal to the checkout; ${art} brand image and font files (separately licensed) counted`)
	const pkg = shipped.get('package.json')
	if (!pkg) { r.add('shell', 'FAIL', 'app.asar: package.json missing'); return }
	const own = JSON.parse(pkg.toString('utf8')), source = readJson(join(SOURCE, 'desktop/package.json'))
	const fields = ['name', 'version', 'main', 'type'].filter(key => own[key] !== source[key])
	r.add('shell', fields.length ? 'FAIL' : 'PASS', fields.length ? `app.asar package.json differs in ${fields.join(', ')}` : `app.asar package.json: ${own.name} ${own.version}, main ${own.main}`)
}

/** Every file below `dir` except the given top-level folder, with its sha256. */
function hashesOutside(dir, skip) {
	return new Map((existsSync(dir) ? walk(dir) : []).filter(path => !path.startsWith(`${skip}/`)).map(path => [path, sha256File(join(dir, path))]))
}

/** Binds the bytes that run to the candidate's own AppBundle (--appbundle). */
function checkPayload(r, bundle, reference) {
	if (!reference) { r.add('payload', 'NOT_RUN', 'no reference AppBundle (--appbundle): the program files are tied to this source only through their source maps'); return }
	if (resolve(bundle) === resolve(reference)) { r.add('payload', 'NOT_RUN', 'the reference is the artifact itself'); return }
	const own = join(bundle, 'steelseed/composition.json'), ref = join(reference, 'steelseed/composition.json')
	if (!existsSync(own) || !existsSync(ref)) { r.add('payload', 'FAIL', `composition.json missing in ${existsSync(own) ? 'the reference' : 'the artifact'}`); return }
	const same = readFileSync(own).equals(readFileSync(ref))
	r.add('payload', same ? 'PASS' : 'FAIL', same ? 'composition.json equals the reference build\'s' : 'composition.json differs from the reference build\'s')
	const listed = new Map(readJson(own).files.map(f => [f.path, f.sha256]))
	const present = walk(join(bundle, 'steelseed')).filter(path => path !== 'composition.json')
	const unlisted = present.filter(path => !listed.has(path))
	const wrong = [...listed].filter(([path, want]) => !existsSync(join(bundle, 'steelseed', path)) || sha256File(join(bundle, 'steelseed', path)) !== want).map(([path]) => path)
	r.add('payload', unlisted.length || wrong.length ? 'FAIL' : 'PASS', unlisted.length || wrong.length
		? `presentation: ${wrong.length} listed files missing or different (${wrong.slice(0, 4).join(', ')}), ${unlisted.length} unlisted (${unlisted.slice(0, 4).join(', ')})`
		: `presentation: ${listed.size} files present and equal to composition.json, none unlisted`)
	const mine = hashesOutside(bundle, 'steelseed'), theirs = hashesOutside(reference, 'steelseed')
	const differ = [...theirs].filter(([path, hash]) => mine.get(path) !== hash).map(([path]) => path), extra = [...mine.keys()].filter(path => !theirs.has(path))
	r.add('payload', differ.length || extra.length || !theirs.size ? 'FAIL' : 'PASS', !theirs.size ? 'the reference has no runtime beside steelseed/'
		: differ.length || extra.length ? `runtime: ${differ.length} files missing or different from the reference (${differ.slice(0, 4).join(', ')}), ${extra.length} not in it (${extra.slice(0, 4).join(', ')})`
		: `runtime: ${theirs.size} files (WebAssembly, assemblies, boot config, generated rules, host scripts) equal the reference`)
}

/** A rebuild from this checkout against the candidate's program files (reported, not required). */
function checkRebuild(r, bundle) {
	if (!REBUILD) { r.add('rebuild', 'NOT_RUN', 'no --rebuild: nothing rebuilt from this checkout was compared'); return }
	if (!bundle) { r.add('rebuild', 'NOT_RUN', 'no AppBundle of the candidate to compare the rebuild with'); return }
	const program = path => /\.(m?js|wasm|dll|dat|json|html)$/.test(path) && !path.endsWith('composition.json')
	const mine = [...hashesOutside(bundle, '__none__')].filter(([path]) => program(path)), theirs = hashesOutside(REBUILD, '__none__')
	const equal = mine.filter(([path, hash]) => theirs.get(path) === hash).length
	r.add('rebuild', equal === mine.length && mine.length ? 'PASS' : 'FAIL', `${equal} of ${mine.length} program files equal the rebuild in ${REBUILD}`)
}

const platformRuns = PLATFORM_REPORT ? readJson(PLATFORM_REPORT) : []
function checkPlatform(r, name) {
	const runs = platformRuns.filter(run => run.artifact === name)
	if (!runs.length) { r.add('platform', 'NOT_RUN', 'no recorded run of this package (--platform-report)'); return }
	for (const run of runs) r.add('platform', run.pass ? 'PASS' : 'FAIL', `${run.platform}: ${run.check}${run.date ? ` on ${run.date}` : ''}${run.evidence ? ` (${run.evidence})` : ''}`)
}

/** The checks an official release decision needs, per artifact kind (--strict). */
export const REQUIRED = {
	live: ['identity', 'client', 'payload', 'framework', 'notices'],
	appbundle: ['identity', 'client', 'payload', 'notices'],
	desktop: ['integrity', 'identity', 'node', 'client', 'payload', 'shell', 'notices', 'manifest', 'boundary'],
	'node-zip': ['integrity', 'identity', 'node', 'notices', 'manifest', 'boundary'],
	'npm-node': ['integrity', 'identity', 'node', 'notices', 'manifest', 'boundary'],
}
/** The five claims the checks support, kept apart. */
const CLAIMS = {
	'artifact integrity': ['integrity'],
	'source correspondence': ['identity', 'node', 'client', 'payload', 'framework', 'shell', 'manifest', 'boundary'],
	'rebuild evidence': ['rebuild'],
	'notices': ['notices'],
	'platform execution': ['platform'],
}
function enforce(r, kind) {
	r.kind = kind
	if (!STRICT) return
	for (const check of REQUIRED[kind] ?? []) {
		const statuses = r.checks.filter(c => c.check === check).map(c => c.status)
		if (!statuses.includes('PASS') && !statuses.includes('FAIL')) r.add(check, 'FAIL', `required check not executed (${statuses.join(', ') || 'no result'})`)
	}
	for (const c of r.checks) if (c.status === 'GAP') { c.status = 'FAIL'; c.detail += ' (a gap fails --strict)' }
}
function claimsOf(r) {
	return Object.fromEntries(Object.entries(CLAIMS).map(([claim, checks]) => {
		const statuses = r.checks.filter(c => checks.includes(c.check)).map(c => c.status)
		return [claim, statuses.includes('FAIL') ? 'FAIL' : statuses.includes('PASS') && statuses.every(s => s === 'PASS' || s === 'INFO') ? 'PASS' : 'NOT_RUN']
	}))
}

// ---------------------------------------------------------------------------------------------

async function verifyUrl(url) {
	const base = url.endsWith('/') ? url : `${url}/`
	const r = report(base)
	const get = async path => { const res = await fetch(new URL(path, base)); if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`); return res }
	const build = await (await get('build.json')).json()
	checkIdentity(r, null, [['live build.json', build]])
	const compositionBytes = Buffer.from(await (await get('composition.json')).arrayBuffer())
	const composition = JSON.parse(compositionBytes.toString('utf8'))
	const listed = new Map(composition.files.map(f => [f.path, f.sha256]))
	// The served code is the composition's code.
	const scripts = composition.files.filter(f => f.path.endsWith('.js'))
	const wrong = []
	for (const { path, sha256: want } of scripts)
		if (sha256(Buffer.from(await (await get(path)).arrayBuffer())) !== want) wrong.push(path)
	r.add('client', wrong.length ? 'FAIL' : 'PASS', wrong.length ? `served scripts differ from composition.json: ${wrong.join(', ')}`
		: `${scripts.length} served scripts match composition.json`)
	const mapFiles = composition.files.filter(f => f.path.endsWith('.js.map'))
	const probe = mapFiles.length ? await fetch(new URL(mapFiles[0].path, base)) : null
	const maps = []
	if (probe?.ok) {
		for (const { path } of mapFiles) maps.push({ name: path, json: await (await get(path)).json() })
	} else if (APPBUNDLE) {
		const local = join(APPBUNDLE, 'steelseed')
		const same = existsSync(join(local, 'composition.json')) && readFileSync(join(local, 'composition.json')).equals(compositionBytes)
		r.add('client', same ? 'PASS' : 'FAIL', same ? `source maps are not served; --appbundle carries the identical composition.json`
			: '--appbundle does not carry the live composition.json')
		r.add('payload', same ? 'PASS' : 'FAIL', same ? 'the live composition.json is the reference build\'s; its served scripts are checked above' : 'the live composition.json is not the reference build\'s')
		if (!same) return r
		const badMaps = mapFiles.filter(({ path }) => !existsSync(join(local, path)) || sha256File(join(local, path)) !== listed.get(path))
		r.add('client', badMaps.length ? 'FAIL' : 'PASS', badMaps.length ? `--appbundle maps differ from composition.json: ${badMaps.map(m => m.path).join(', ')}`
			: `${mapFiles.length} source maps from --appbundle match composition.json`)
		for (const { path } of mapFiles) maps.push({ name: path, json: readJson(join(local, path)) })
	} else {
		r.add('client', 'FAIL', 'the site does not serve its source maps; pass the build\'s AppBundle with --appbundle <dir>')
		return r
	}
	checkMaps(r, maps)
	for (const [label, path] of [['GPL text', 'licenses/COPYING-GPLv3.txt'], ['OpenRA AUTHORS', 'licenses/AUTHORS-OpenRA.txt'], ['third-party notices', 'licenses/THIRD-PARTY-NOTICES.txt'],
		['GPL v2 text', 'licenses/GPL-2.0.txt'], ['LGPL v2.1 text', 'licenses/LGPL-2.1.txt'], ['LGPL v3 text', 'licenses/LGPL-3.0.txt']]) {
		const res = await fetch(new URL(path, base))
		checkLegalText(r, `${label} (served)`, res.ok ? Buffer.from(await res.arrayBuffer()) : null)
	}
	if (APPBUNDLE) {
		// The WebAssembly runtime and the engine assemblies: every file the build carries in _framework/
		// is served unchanged, so the build's identity (build.json, above) is the served engine's.
		const framework = join(APPBUNDLE, '_framework'), root = new URL('../', base)
		const files = existsSync(framework) ? walk(framework) : []
		const differ = [], unserved = []
		for (const rel of files) {
			const res = await fetch(new URL(`_framework/${rel}`, root))
			// Like the client's, the runtime's source maps are not served; every other file must be.
			if (res.status === 404 && rel.endsWith('.map')) { unserved.push(rel); continue }
			if (!res.ok || sha256(Buffer.from(await res.arrayBuffer())) !== sha256File(join(framework, rel))) differ.push(rel)
		}
		const served = files.length - unserved.length
		r.add('framework', !served || differ.length ? 'FAIL' : 'PASS', !files.length ? '--appbundle has no _framework/'
			: differ.length ? `${differ.length} served _framework files differ from the build: ${differ.slice(0, 4).join(', ')}`
			: `${served} served _framework files equal the build's`)
		if (unserved.length) r.add('framework', 'INFO', `${unserved.length} runtime source maps are not served (${unserved.join(', ')})`)
	} else r.add('framework', 'NOT_RUN', 'no --appbundle: the served _framework/ was not compared with a build')
	checkRebuild(r, APPBUNDLE ?? null)
	enforce(r, 'live')
	return r
}

/** A local AppBundle directory (the output of compose, or a CI artifact of one). */
function verifyAppBundle(dir) {
	const r = report(dir)
	const steelseed = join(dir, 'steelseed')
	checkIdentity(r, null, [['AppBundle build.json', existsSync(join(steelseed, 'build.json')) ? readJson(join(steelseed, 'build.json')) : null]])
	const composition = readJson(join(steelseed, 'composition.json'))
	const bad = composition.files.filter(({ path, sha256: want }) => !existsSync(join(steelseed, path)) || sha256File(join(steelseed, path)) !== want)
	r.add('client', bad.length ? 'FAIL' : 'PASS', bad.length ? `${bad.length} files differ from composition.json: ${bad.slice(0, 4).map(f => f.path).join(', ')}`
		: `${composition.files.length} files match composition.json`)
	const assets = join(steelseed, 'assets')
	checkMaps(r, readdirSync(assets).filter(f => f.endsWith('.js.map')).map(f => ({ name: f, json: readJson(join(assets, f)) })))
	checkLegal(r, [['GPL text', 'licenses/COPYING-GPLv3.txt'], ['OpenRA AUTHORS', 'licenses/AUTHORS-OpenRA.txt'], ['third-party notices', 'licenses/THIRD-PARTY-NOTICES.txt'], ['GPL v2 text', 'licenses/GPL-2.0.txt'], ['LGPL v2.1 text', 'licenses/LGPL-2.1.txt'], ['LGPL v3 text', 'licenses/LGPL-3.0.txt']]
		.map(([label, rel]) => ({ label, file: join(steelseed, rel) })))
	checkPayload(r, dir, APPBUNDLE)
	checkRebuild(r, dir)
	enforce(r, 'appbundle')
	return r
}

function verifyFile(file) {
	const name = basename(file)
	const r = report(name)
	const digest = sha256Stream(file)
	r.artifact = { name, bytes: statSync(file).size, sha256: digest }
	if (SUMS) {
		const listed = sums.get(name)
		r.add('integrity', listed === digest ? 'PASS' : 'FAIL', listed ? `sha256 ${digest.slice(0, 16)}… ${listed === digest ? '=' : '≠'} SHA256SUMS` : 'not listed in SHA256SUMS')
	} else r.add('integrity', STRICT ? 'FAIL' : 'INFO', STRICT ? `sha256 ${digest}: no independent record to check it against (--sums)` : `sha256 ${digest}`)
	const into = mkdtempSync(join(tmpdir(), 'redline-verify-'))
	try {
		const unpacked = unpack(file, into)
		const assembly = checkNode(r, unpacked.nodeRoot, unpacked.kind)
		const builds = [['node generated/build.json', existsSync(join(unpacked.nodeRoot, 'steelseed-host/generated/build.json'))
			? readJson(join(unpacked.nodeRoot, 'steelseed-host/generated/build.json')) : null]]
		if (unpacked.appBundle) builds.push(['AppBundle build.json', existsSync(join(unpacked.appBundle, 'steelseed/build.json'))
			? readJson(join(unpacked.appBundle, 'steelseed/build.json')) : null])
		checkIdentity(r, assembly?.commit ?? null, builds)
		if (unpacked.appBundle) {
			const assets = join(unpacked.appBundle, 'steelseed/assets')
			checkMaps(r, readdirSync(assets).filter(f => f.endsWith('.js.map')).map(f => ({ name: f, json: readJson(join(assets, f)) })))
		}
		checkLegal(r, unpacked.legal)
		checkManifest(r, unpacked.manifest, name)
		checkBoundary(r, unpacked.kind, unpacked.scanRoot, unpacked.appBundle)
		if (unpacked.kind === 'desktop') {
			checkPayload(r, unpacked.appBundle, APPBUNDLE)
			checkShell(r, unpacked.resources)
			checkRebuild(r, unpacked.appBundle)
		}
		checkPlatform(r, name)
		enforce(r, unpacked.kind)
	} finally {
		rmSync(into, { recursive: true, force: true })
	}
	return r
}

const reports = []
for (const target of targets) {
	try {
		reports.push(/^https?:\/\//.test(target) ? await verifyUrl(target)
			: statSync(resolve(target)).isDirectory() ? verifyAppBundle(resolve(target)) : verifyFile(resolve(target)))
	} catch (error) {
		const r = report(target)
		r.add('verify', 'FAIL', error.message)
		reports.push(r)
	}
}
let failed = 0
for (const r of reports) {
	const bad = r.checks.filter(c => c.status === 'FAIL').length
	failed += bad
	r.claims = claimsOf(r)
	console.log(`\n${bad ? 'FAIL' : 'PASS'}  ${r.name}`)
	for (const c of r.checks) console.log(`  ${c.status.padEnd(7)}  ${c.check.padEnd(9)}  ${c.detail}`)
	console.log(`  claims: ${Object.entries(r.claims).map(([claim, status]) => `${claim} ${status}`).join('; ')}`)
}
const mode = STRICT ? 'strict (official release decision)' : 'audit (not a release decision)'
if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify({ schema: 2, mode, generatedAt: new Date().toISOString(), node: process.version,
	command: process.argv.slice(2), source: releaseSource, checkout: { commit: checkoutCommit, tag: checkoutTag }, builtMod,
	reports: reports.map(({ name, kind, artifact, checks, claims }) => ({ name, kind, artifact, claims, checks })) }, null, 2)}\n`)
console.log(`\nverify-release [${mode}]: ${failed ? `FAIL (${failed})` : 'PASS'} — ${reports.length} artifact(s) against ${releaseSource ? releaseSource.sourceCommit.slice(0, 12) : SOURCE}`)
process.exit(failed ? 1 : 0)
