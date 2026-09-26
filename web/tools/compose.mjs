#!/usr/bin/env node
// STEELSEED — tools/compose
// Assemble the generated Vite presentation beneath the generated OpenRA AppBundle.
// Source directories remain independent; only ignored build output is composed.

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME_ROOT = resolve(WEB_ROOT, '..')
const DIST = join(WEB_ROOT, 'dist')
const APP_BUNDLE = join(GAME_ROOT, 'engine', 'bin-browser', 'AppBundle')
const TARGET = join(APP_BUNDLE, 'steelseed')
const HOST_SCRIPT = '<script type="module" src="../main.js"></script>'

requireFile(join(DIST, 'index.html'), 'run `npm run build` first')
requireFile(join(APP_BUNDLE, 'main.js'), 'publish OpenRA.Browser first')
requireFile(join(APP_BUNDLE, '_framework', 'dotnet.js'), 'OpenRA AppBundle is incomplete')
const GENERATED_BUILD = join(GAME_ROOT, 'engine', 'steelseed-host', 'generated', 'build.json')
requireFile(GENERATED_BUILD, 'run `node engine/steelseed-host/tools/build-ra-mod.mjs` first (§5.8 sim build id)')

// Keep immutable hashed assets available to tabs still loading the previous build.
// Replace entry points and other unversioned output; never remove their dependencies
// before the new entry has been written.
mkdirSync(TARGET, { recursive: true })
for (const entry of readdirSync(TARGET)) {
	if (entry !== 'assets' && entry !== 'index.html') rmSync(join(TARGET, entry), { recursive: true, force: true })
}
for (const entry of readdirSync(DIST)) {
	if (entry !== 'index.html') cpSync(join(DIST, entry), join(TARGET, entry), { recursive: true })
}

// The sim build id (§5.8) is stamped by build-ra-mod and must ship with every AppBundle:
// a bundle that cannot state its simulation content is indistinguishable from a
// mismatched one over the wire.
const generatedBuild = JSON.parse(readFileSync(GENERATED_BUILD, 'utf8'))
if (typeof generatedBuild.simBuild !== 'string' || !/^[0-9a-f]{12}$/.test(generatedBuild.simBuild) ||
	typeof generatedBuild.modHash !== 'string' || !/^[0-9a-f]{64}$/.test(generatedBuild.modHash))
	throw new Error('compose: generated/build.json has no usable simBuild/modHash; rerun build-ra-mod.mjs')
const appVersion = JSON.parse(readFileSync(join(GAME_ROOT, 'desktop', 'package.json'), 'utf8')).version
writeFileSync(join(TARGET, 'build.json'), `${JSON.stringify({ ...generatedBuild, app: appVersion }, null, 2)}\n`)
// T4.3: the browser switch ships with every deployment, so a release cannot
// forget it (§5.1 — a missing file means `off` anyway). A hand-authored
// web/public/net-config.json wins: it is how the switch ever leaves `off`.
const netConfigSource = join(GAME_ROOT, 'web', 'public', 'net-config.json')
const netConfig = existsSync(netConfigSource)
	? readFileSync(netConfigSource, 'utf8')
	: `${JSON.stringify({
		schema: 1,
		relay: 'https://play.redlinewars.online',
		accountOrigin: 'https://www.redlinewars.online',
		browserMultiplayer: 'off',
	})}\n`
writeFileSync(join(TARGET, 'net-config.json'), netConfig)

// The page ships the GPL engine as WebAssembly: its licence, OpenRA's authors, the third-party
// notices and the licences of the libraries it bundles (FuzzyLogicLibrary under the GPL v2, TagLib#
// under the LGPL v2.1, MP3Sharp under the LGPL v3) travel with every AppBundle (the in-game
// Copyright screen links them). Presentation files only — the sim build id does not change.
const licences = join(TARGET, 'licenses')
mkdirSync(licences, { recursive: true })
for (const [from, to] of [
	['engine/COPYING', 'COPYING-GPLv3.txt'],
	['engine/AUTHORS', 'AUTHORS-OpenRA.txt'],
	['THIRD_PARTY_NOTICES.md', 'THIRD-PARTY-NOTICES.txt'],
	['engine/licenses/GPL-2.0.txt', 'GPL-2.0.txt'],
	['engine/licenses/LGPL-2.1.txt', 'LGPL-2.1.txt'],
	['engine/licenses/LGPL-3.0.txt', 'LGPL-3.0.txt'],
]) {
	requireFile(join(GAME_ROOT, from), `compose: ${from} must ship with the AppBundle`)
	cpSync(join(GAME_ROOT, from), join(licences, to))
}

const indexPath = join(TARGET, 'index.html')
const index = readFileSync(join(DIST, 'index.html'), 'utf8')
const presentationScript = /<script type="module"[^>]*src="\.\/assets\/[^\"]+"[^>]*><\/script>/
if (!presentationScript.test(index))
	throw new Error('compose: Vite index has no relative presentation module marker')
const withHost = index.replace(presentationScript, `${HOST_SCRIPT}\n\t\t$&`)
// The boot redirect pins mode=game for the engine while KEEPING any extra query
// the player arrived with (?debug=on&hostedon, ?join=<roomId>, …) — T5.5/T5.6
// deep links depend on their parameters surviving the redirect.
const bootHost = '<script>(function(){var q=location.search;if(!/[?&]mode=/.test(q)){var extra=q?\'&\'+q.slice(1):"";location.replace(location.pathname+"?mode=game&platform=null"+extra+location.hash)}})()</script>'
writeFileSync(indexPath, withHost.includes('</head>') ? withHost.replace('</head>', `\t${bootHost}\n\t</head>`) : `${bootHost}\n${withHost}`)

// --prune: keep only this build's hashed assets. Local iteration otherwise piles up every
// earlier generation (measured 458 MiB composed against 220 MiB of dist), and a release
// candidate assembled from that tree would upload all of it. Runs after the new entry is
// written, so nothing the new index needs is ever missing; old tabs are the server's job.
if (process.argv.includes('--prune')) {
	const keep = new Set(listFiles(join(DIST, 'assets')).map(path => relative(join(DIST, 'assets'), path)))
	let pruned = 0
	for (const path of listFiles(join(TARGET, 'assets'))) {
		if (keep.has(relative(join(TARGET, 'assets'), path))) continue
		rmSync(path, { force: true })
		pruned++
	}
	console.log(`compose: pruned ${pruned} stale assets from earlier builds`)
}

const files = listFiles(TARGET)
const manifest = {
	schema: 1,
	entry: 'steelseed/index.html?mode=game&platform=null',
	host: '../main.js',
	files: files.map(path => ({
		path: relative(TARGET, path).replaceAll('\\', '/'),
		bytes: statSync(path).size,
		sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
	})),
}
writeFileSync(join(TARGET, 'composition.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
console.log(`compose: PASS — ${manifest.files.length} presentation files, ${bytes} bytes -> ${TARGET}`)

function requireFile(path, help) {
	if (!existsSync(path)) throw new Error(`compose: missing ${path}; ${help}`)
}

function listFiles(root) {
	const out = []
	const visit = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) visit(path)
			else if (entry.isFile()) out.push(path)
		}
	}
	visit(root)
	return out.sort()
}
