#!/usr/bin/env node
// Redline Wars — compliance release exporter.
//
// Writes the public corresponding source of ONE distributed version of Redline Wars: Fractured
// Order from the private monorepo, reading it only through `git ls-tree` and `git archive` of a
// fixed commit. Nothing is ever written to the monorepo.
//
//   node tools/export-release.mjs --source <monorepo> --commit <sha> --out <dir>
//
// What is published and what stays private is decided per path below. Every tracked path must
// match one of the two lists, so a new top-level directory can never leave (or be dropped)
// without a decision; an unclassified path fails the export.
//
// Published: the OpenRA fork and its WebAssembly port, the dedicated server, the multiplayer
// node, room host and relay (engine/), the WebGPU client and its build and gate tools (web/),
// the Electron shell (desktop/), and the provenance locks the client build reads (art/*.lock).
// Kept private, as compliance.md decides: the marketing site (landing/), the Blender sources and
// art pipeline (art/), brand artwork, production infrastructure (deploy/, .github/), and internal
// notes. Separately licensed artwork is replaced at build time by tools/fallback-art.mjs.
//
// A self-check fails the export on private keys, tokens, credential assignments and secret-like
// files, and reports home-directory paths, private repository names and hosts for review. A
// passing export ends with RELEASE-SOURCE.json: the source commit, and what was withheld and why.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const TOOL = 'export-release'
const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null }
const SOURCE = option('source'), COMMIT = option('commit'), OUT = option('out')
if (!SOURCE || !COMMIT || !OUT) {
	console.error(`usage: node tools/export-release.mjs --source <monorepo> --commit <sha> --out <dir>`)
	process.exit(2)
}
const out = resolve(OUT)

// ---------------------------------------------------------------------------------------------
// Decisions. An entry ending in "/" covers everything beneath it; one ending in "*" covers every
// path that starts with the text before the star; any other entry is one exact path.
// ---------------------------------------------------------------------------------------------

const PUBLISH = [
	['engine/', 'the OpenRA fork, its WebAssembly port, dedicated server, node, room host and relay'],
	['web/', 'the WebGPU client, its build (vite, compose) and its gates'],
	['desktop/', 'the Electron shell and its packager'],
	['art/sources.lock.json', 'provenance record of external art sources, read by the client build'],
	['art/supplied-inputs.lock.json', 'provenance record of supplied art inputs, read by the client build'],
	['art/content-provenance.json', 'provenance record of every shipped creative file, read by web/tools/sourcelicensegate.mjs'],
	['global.json', '.NET SDK pin'],
	['AUTHORS', "OpenRA's contributors"],
	['ARCHITECTURE.md', 'architecture and the snapshot ABI (§4) the code refers to'],
	['.gitignore', 'build outputs'],
]

const PRIVATE = [
	['engine/.github/', "upstream OpenRA's CI and funding templates"],
	['engine/bin-browser-legacy/', 'tracked compiled binaries of the original host (build output)'],
	['engine/steelseed-host/tools/vmlab/', 'internal VM lab'],
	['engine/steelseed-host/COMPLETION-AUDIT.md', 'internal acceptance record'],
	['web/.tmp-*', 'scratch scripts'],
	// The art pipeline: generators that build separately licensed art (Blender forges, paid TTS and
	// SFX renders, promotion of supplied .blend files). They build no part of the game's code.
	// art-fetch.mjs is published: the published web/tools/sourcelicensegate.mjs imports it, and it
	// only fetches and checks the recorded CC0/CC-BY sources; it holds no art.
	...['blender-forge.mjs', 'environment-forge.mjs', 'material-forge.mjs', 'tree-forge.mjs', 'forge.mjs',
		'rosterbake.mjs', 'promoterifle.mjs', 'rifleassetgate.mjs', 'gen-death-voices.mjs', 'gen-shout-voices.mjs',
		'render-jackson-elevenlabs.mjs', 'render-riki-elevenlabs.mjs', 'render-sfx-elevenlabs.mjs', 'render-spy-elevenlabs.mjs',
		'render-voices-cartesia.mjs'].map(name => [`web/tools/${name}`, 'art pipeline (builds separately licensed art)']),
	['web/.forge/', 'built art packs (separately licensed); tools/fallback-art.mjs writes public stand-ins'],
	['desktop/build/icon.*', 'brand artwork (© Jolyn Studios); tools/fallback-art.mjs writes stand-ins'],
	['desktop/build/brandmark.svg', 'brand artwork (© Jolyn Studios)'],
	['desktop/shell/bg-*', 'artwork (© Jolyn Studios); tools/fallback-art.mjs writes stand-ins'],
	['desktop/shell/hero-*', 'artwork (© Jolyn Studios); tools/fallback-art.mjs writes stand-ins'],
	['landing/', 'the marketing site'],
	['art/', 'Blender sources and the art pipeline'],
	['brand/', 'brand artwork'],
	['deploy/', 'production infrastructure'],
	['.github/', 'CI naming production hosts and secrets'],
	['docs/', 'internal measurements and notes'],
	['docs-archive/', 'internal notes'],
	['issues/', 'internal issue notes'],
	['plan/', 'internal plans'],
	['codex backup/', 'local backup tree'],
	['Blender-Review/', 'art review notes'],
	['scripts/', 'internal tooling'],
	...['.env.example', 'AGENTS.md', 'BLOG-HOW-WE-DID-IT.md', 'CLAUDE.md', 'DEPLOY.md', 'INFRASTRUCTURE.md',
		'LICENSE', 'MULTIPLAYER-BOUNDARY.md', 'MULTIPLAYER-SERVICE.md', 'PLANX-PRIORITEITEN.md', 'PLANX-REPORT.md',
		'PROMPT.md', 'README.md', 'REMODEL.md', 'SECRETS.md', 'SPELEN.md', 'STEELSEED-STORY.md', 'THIRD_PARTY_NOTICES.md',
		'WORKSPACE-RESTORE.md', 'agentvsgentport.md', 'codex-air-naval.md', 'codex-riki-repair.md', 'command.md',
		'improvements-by-grok.md', 'ordergate.mjs']
		.map(name => [name, name === 'LICENSE' || name === 'README.md' || name === 'THIRD_PARTY_NOTICES.md'
			? 'replaced by the public edition at the repository root' : 'internal document']),
]

// Build outputs never leave, even inside a published directory.
const BUILD_OUTPUT = new Set(['bin', 'obj', 'bin-browser', 'bin-browser-legacy', 'bin-browser-reference', 'bin-browser-aot',
	'bin-standalone', 'node_modules', 'generated', 'test-results', 'playwright-report', '.artifacts', 'dist', 'shots'])

const matches = (path, entry) => entry.endsWith('/') ? path.startsWith(entry)
	: entry.endsWith('*') ? path.startsWith(entry.slice(0, -1)) : path === entry
const used = new Set()
function decide(path) {
	// The most specific matching entry decides (an exact path beats a directory it lies in); on a
	// tie, private wins. Build output never leaves, whatever directory it sits in.
	let best = null
	for (const [list, publish] of [[PRIVATE, false], [PUBLISH, true]])
		for (const [entry, why] of list)
			if (matches(path, entry) && (!best || entry.length > best.entry.length)) best = { entry, why, publish }
	if (best && !best.publish) { used.add(best.entry); return { publish: false, why: best.why } }
	if (path.split('/').slice(0, -1).some(segment => BUILD_OUTPUT.has(segment))) return { publish: false, why: 'build output' }
	return best ? { publish: true, why: best.why } : null
}

// ---------------------------------------------------------------------------------------------
// Self-check.
// ---------------------------------------------------------------------------------------------

const FATAL = [
	['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
	['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
	['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
	['api-key', /\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{24,}/g],
	['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
	['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
	['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
	['resend-key', /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g],
	['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:[^\s@/'"`]{6,}@/gi],
]
const SECRET_FILE = [/(?:^|\/)\.env(?:\.(?!example$|sample$|template$).+)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
	/\.keystore$/i, /\.jks$/i, /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/, /(?:^|\/)\.npmrc$/, /(?:^|\/)\.netrc$/]
const REVIEW = [
	['home-path', /(?:\/Users\/|\/home\/)(?!runner\/|user\/|you\/|username\/|<)[A-Za-z0-9._-]+\//g],
	['private-repo-name', /\bnillo\/redline-wars\b/g],
	['private-repository', /github\.com\/(?:proofofworks|proofofwork-agency)\/[\w.-]+/gi],
	['host', /\b(?:[a-z0-9-]+\.)*(?:redlinewars\.online|proofofwork\.agency)\b/gi],
]

function isBinary(bytes) {
	const n = Math.min(bytes.length, 8000)
	for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
	return false
}

function walk(dir, base = dir, found = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (name === '.git') continue
		if (statSync(path).isDirectory()) walk(path, base, found)
		else found.push(path.slice(base.length + 1))
	}
	return found
}

// ---------------------------------------------------------------------------------------------
// Export.
// ---------------------------------------------------------------------------------------------

const git = argv => execFileSync('git', ['-C', resolve(SOURCE), ...argv], { maxBuffer: 1024 * 1024 * 1024 })
const commit = git(['rev-parse', '--verify', `${COMMIT}^{commit}`]).toString().trim()
const tracked = git(['ls-tree', '-r', '--name-only', '-z', commit]).toString().split('\0').filter(Boolean)
const publish = [], keep = new Map(), unclassified = []
for (const path of tracked) {
	const decision = decide(path)
	if (decision === null) unclassified.push(path)
	else if (decision.publish) publish.push(path)
	else keep.set(decision.why, (keep.get(decision.why) ?? 0) + 1)
}
if (unclassified.length) {
	console.error(`${TOOL}: ${unclassified.length} tracked paths have no decision:\n  ${unclassified.slice(0, 40).join('\n  ')}`)
	process.exit(1)
}
// A private entry that decides nothing is a mistyped rule, and a mistyped rule publishes what it
// was meant to keep.
const unused = PRIVATE.map(([entry]) => entry).filter(entry => !used.has(entry))
if (unused.length) {
	console.error(`${TOOL}: private entries that match no tracked path at ${commit.slice(0, 12)}:\n  ${unused.join('\n  ')}`)
	process.exit(1)
}
if (existsSync(out) && readdirSync(out).some(name => name !== '.git' && name !== 'LICENSE'))
	throw new Error(`${TOOL}: ${out} must be empty but for .git and LICENSE`)
mkdirSync(out, { recursive: true })
// git archive of exactly the published paths, in batches so the command line stays short.
for (let i = 0; i < publish.length; i += 500) {
	const tar = git(['archive', '--format=tar', commit, '--', ...publish.slice(i, i + 500)])
	execFileSync('tar', ['-x', '-C', out], { input: tar, maxBuffer: 1024 * 1024 * 1024 })
}

// Documentation-only rewrites: local paths on the author's machine in reports and notes. None
// touches code the build runs; each must match, so a changed file fails loudly. "~" stands for any
// home directory (/Users/<name> or /home/<name>).
const REWRITES = [
	['engine/OpenRA.Browser/tests/match-results/LEADERBOARD.md', 'from ~/projects/proofofworks/OpenRA-Web/OpenRA.Browser/tests/match-results', 'from OpenRA.Browser/tests/match-results'],
	['web/tools/nightlight-reference.json', '~/projects/proofofworks/games/steelseed/web/shots/nightlights', 'web/shots/nightlights'],
]
const homePattern = from => new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('~', '(?:/Users|/home)/[^/\\s`]+'), 'g')
const rewritten = []
for (const [path, from, to] of REWRITES) {
	const file = join(out, path)
	if (!existsSync(file)) continue
	const text = readFileSync(file, 'utf8')
	const pattern = homePattern(from)
	const count = [...text.matchAll(pattern)].length
	if (count < 1) throw new Error(`${TOOL}: rewrite of ${path} found no ${JSON.stringify(from)}`)
	writeFileSync(file, text.replace(pattern, to))
	// The record names the replacement, never the local path it removed.
	rewritten.push({ path, count, replacement: to })
}

const fatal = [], review = new Map()
for (const path of walk(out)) {
	if (path === 'LICENSE') continue
	if (SECRET_FILE.some(re => re.test(path))) fatal.push(`${path}: secret-like file name`)
	const bytes = readFileSync(join(out, path))
	if (isBinary(bytes)) continue
	const text = bytes.toString('utf8')
	for (const [kind, re] of FATAL) for (const m of text.matchAll(re)) fatal.push(`${path}: ${kind} ${m[0].slice(0, 12)}…`)
	for (const [kind, re] of REVIEW) for (const m of text.matchAll(re)) {
		const key = `${kind} ${m[0]}`
		if (!review.has(key)) review.set(key, new Set())
		review.get(key).add(path)
	}
}

console.log(`${TOOL}: ${commit.slice(0, 12)} → ${out}`)
console.log(`  published ${publish.length} of ${tracked.length} tracked files`)
for (const [why, n] of [...keep.entries()].sort((a, b) => b[1] - a[1])) console.log(`  kept private: ${n} — ${why}`)
for (const { path, count, replacement } of rewritten) console.log(`  rewritten: ${path}: ${count} local path(s) → ${replacement}`)
if (review.size) {
	console.log('  review (not fatal):')
	for (const [key, paths] of [...review.entries()].sort()) console.log(`    ${key}  (${paths.size} file${paths.size > 1 ? 's' : ''}: ${[...paths].slice(0, 3).join(', ')}${paths.size > 3 ? ', …' : ''})`)
}
if (fatal.length) {
	console.error(`${TOOL}: FAIL — ${fatal.length} finding(s):\n  ${fatal.slice(0, 50).join('\n  ')}`)
	process.exit(1)
}
// The record of what this tree is: the verifier (tools/verify-release.mjs) reads it.
const committed = git(['show', '-s', '--format=%cI', commit]).toString().trim()
writeFileSync(join(out, 'RELEASE-SOURCE.json'), `${JSON.stringify({
	schema: 1,
	product: 'Redline Wars: Fractured Order',
	sourceCommit: commit,
	sourceCommitDate: committed,
	exportedWith: 'tools/export-release.mjs',
	published: publish.length,
	withheld: Object.fromEntries([...keep.entries()].sort((x, y) => y[1] - x[1])),
	rewritten,
}, null, 2)}\n`)
console.log(`${TOOL}: PASS`)
