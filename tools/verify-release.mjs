#!/usr/bin/env node
// Redline Wars — check distributed artifacts against their public source.
//
//   node tools/verify-release.mjs --source <checkout> [--sums <SHA256SUMS>] [--require-manifest]
//                                 [--appbundle <dir>] [--json <report.json>] <artifact | URL>...
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

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null }
const SOURCE = option('source') && resolve(option('source'))
const SUMS = option('sums'), JSON_OUT = option('json'), REQUIRE_MANIFEST = args.includes('--require-manifest')
const APPBUNDLE = option('appbundle') && resolve(option('appbundle'))
const targets = args.filter((a, i) => !a.startsWith('--') && !['--source', '--sums', '--json', '--appbundle'].includes(args[i - 1]))
if (!SOURCE || !targets.length) {
	console.error('usage: node tools/verify-release.mjs --source <checkout> [--sums <SHA256SUMS>] [--require-manifest] [--json <file>] <artifact | URL>...')
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
	return { kind: 'desktop', nodeRoot: join(resources, 'steelseed-node'), appBundle: join(resources, 'AppBundle'), scanRoot: resources,
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
	}
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
	} else r.add('integrity', 'INFO', `sha256 ${digest}`)
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
	console.log(`\n${bad ? 'FAIL' : 'PASS'}  ${r.name}`)
	for (const c of r.checks) console.log(`  ${c.status.padEnd(4)}  ${c.check.padEnd(9)}  ${c.detail}`)
}
if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify({ schema: 1, source: releaseSource, builtMod, reports: reports.map(({ name, artifact, checks }) => ({ name, artifact, checks })) }, null, 2)}\n`)
console.log(`\nverify-release: ${failed ? `FAIL (${failed})` : 'PASS'} — ${reports.length} artifact(s) against ${releaseSource ? releaseSource.sourceCommit.slice(0, 12) : SOURCE}`)
process.exit(failed ? 1 : 0)
