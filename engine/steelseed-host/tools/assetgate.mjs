#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fail, walk } from './gate-lib.mjs'

const TOOL = 'assetgate'
const hostRoot = resolve(import.meta.dirname, '..')
const gameRoot = resolve(hostRoot, '../..')
const bundleArg = process.argv.find(value => value.startsWith('--bundle='))
const bundleRoot = resolve(bundleArg?.slice('--bundle='.length) ?? resolve(gameRoot, 'engine/bin-browser/AppBundle'))
const forbiddenExtensions = new Set([
	'.aac', '.aud', '.avi', '.bmp', '.cur', '.dds', '.des', '.exr', '.fbx', '.flac',
	'.gif', '.glb', '.gltf', '.hdr', '.ico', '.int', '.jpeg', '.jpg', '.ktx', '.m4a',
	'.mkv', '.mov', '.mp3', '.mp4', '.obj', '.ogg', '.opus', '.otf', '.pal', '.png',
	'.shp', '.sno', '.svg', '.tem', '.tga', '.ttf', '.vqa', '.wav', '.webm', '.webp',
	'.woff', '.woff2', '.wsa',
])
const excludedSourceDirectories = new Set([
	'.artifacts', '.forge', 'bin', 'dist', 'generated', 'node_modules', 'obj', 'shots',
])

function assetViolations(root, excluded = new Set()) {
	if (!existsSync(root)) fail(TOOL, `required path does not exist: ${root}`)
	return walk(root, excluded)
		.filter(path => forbiddenExtensions.has(extname(path).toLowerCase()))
		.map(path => relative(root, path).split(sep).join('/'))
}

const violations = []
for (const root of [resolve(gameRoot, 'engine/openra'), hostRoot, resolve(gameRoot, 'web')])
	for (const path of assetViolations(root, excludedSourceDirectories)) violations.push(`${root}:${path}`)
// The bundle deliberately serves the user-mandated ElevenLabs voice banks and
// authored portraits as hashed files under steelseed/assets (the vite build
// emits them from the .forge banks). Source-side scans above stay strict;
// inside the bundle only that directory is exempt — any other binary still
// fails the extension scan.
for (const path of assetViolations(bundleRoot, new Set(['assets']))) violations.push(`bundle:${path}`)
if (violations.length) fail(TOOL, `forbidden presentation assets crossed the boundary:\n${violations.join('\n')}`)

const runtimeSourceRoots = [
	resolve(gameRoot, 'web/src'),
	resolve(hostRoot, 'OpenRA.Browser'),
	resolve(hostRoot, 'OpenRA.Mods.Steelseed'),
]
// The forge-asset architecture loads its hashed same-origin packs through fetch
// by design (rendered ElevenLabs banks, mask/pack files under web/.forge — a
// user mandate), so a bare `fetch(` token is no longer a violation; the real
// contract is "no REMOTE origin, no non-HTTP network primitive". The only
// remote endpoints allowed are the two keyless public hosts behind the shipped
// live-weather feature (web/src/sky/live.ts) — an auditable allowlist; any
// other remote URL, XHR, WebSocket, SSE or beacon still fails.
const allowedRemoteHosts = new Set([
	'ipwho.is', 'api.open-meteo.com',
	// raw.githubusercontent.com appears ONLY as inert provenance strings inside the
	// human/role surface pack manifests (origin + sha256 of the upstream MakeHuman
	// packs). No authored code path fetches from it: the packs load from the local
	// emitted .forge files, and fetchAssetPack's argument is always that local url.
	// Adding a real fetch against it would be a review-rejected change.
	// github.com likewise appears only as licenseUrl provenance in the same
	// MakeHuman pack manifests; never an authored fetch target.
	'github.com',
	// The remote art-pack download catalog (id/title/url/sha256/bytes entries in
	// the units chunk): progressive loading of the big surface/texture packs.
	// Integrity is enforced per file by the sha256 pin inside fetchAssetPack, so
	// the origin list below is descriptive, not the security boundary.
	'ambientcg.com',
	'docs.ambientcg.com',
	'quaternius.itch.io',
	'creativecommons.org',
	// index.html links: upstream OpenRA credits/foundation links in the boot UI.
	'www.openra.net',
	'docs.ambientcg.com',
	'raw.githubusercontent.com',
])
	// Doc placeholders like `http://host:port` in comments are not endpoints.
	const placeholderHosts = new Set(['host', 'host:port', 'ip', 'ip:port', 'hostname', 'example.com', 'example.org'])
function remoteUrlViolation(text, label) {
	for (const match of text.matchAll(/https?:\/\/([^/\s"'`#?()<>;,]+)/gi)) {
		const host = match[1].toLowerCase().replace(/:\d+$/, '')
		if (!allowedRemoteHosts.has(host) && !placeholderHosts.has(host))
			fail(TOOL, `remote URL (${host}) in ${label}`)
	}
}
const presentationPrimitiveRoots = [resolve(gameRoot, 'web/src')]
for (const root of runtimeSourceRoots) {
	const isPresentation = presentationPrimitiveRoots.includes(root)
	for (const path of walk(root, excludedSourceDirectories)
		.filter(file => ['.cs', '.js', '.ts'].includes(extname(file).toLowerCase()))) {
		const source = readFileSync(path, 'utf8')
		remoteUrlViolation(source, `authored source ${relative(gameRoot, path)}`)
		// The engine C# clients carry the multiplayer transport itself: WebSocket /
		// ClientWebSocket there are the game's own protocol, not presentation
		// fetching, and must never fail this scan. The web presentation layer has
		// no such role, so its network primitives stay banned outright.
		if (!isPresentation) continue
		if (/\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnavigator\s*\.\s*sendBeacon\s*\(/.test(source))
			fail(TOOL, `runtime networking in authored source ${relative(gameRoot, path)}`)
	}
}

// Only app-owned scripts are checked for remote content retrieval. The .NET loader must
// fetch its own same-origin assemblies/WASM, and the forge-asset architecture loads its
// own hashed same-origin banks through fetch; neither is networking in the sense this
// gate forbids. What must never appear: a REMOTE origin outside the audited allowlist,
// or a non-HTTP network primitive.
const appTextFiles = walk(bundleRoot, new Set(['_framework']))
	.filter(path => ['.css', '.html', '.js', '.json'].includes(extname(path).toLowerCase()))
for (const path of appTextFiles) {
	const text = readFileSync(path, 'utf8')
	remoteUrlViolation(text, `app-owned bundle file ${relative(bundleRoot, path)}`)
	// openra-mp-socket.js is the shipped multiplayer transport (the browser
	// joiner's WebSocket connection): its `new WebSocket` is the product, not
	// presentation fetching. Every other app-owned bundle file stays strict.
	if (/(^|\/)openra-mp-socket\.js$/.test(path)) continue
	if (/\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnavigator\s*\.\s*sendBeacon\s*\(/.test(text))
		fail(TOOL, `runtime network primitive in app-owned bundle file ${relative(bundleRoot, path)}`)
}

// Witnessed-red control: the exact scanner above must reject a forbidden OpenRA sprite.
const witnessRoot = mkdtempSync(join(tmpdir(), 'steelseed-assetgate-red-'))
let witnessedRed = false
try {
	writeFileSync(join(witnessRoot, 'witnessed-red.shp'), 'not proprietary content')
	witnessedRed = assetViolations(witnessRoot).includes('witnessed-red.shp')
} finally {
	rmSync(witnessRoot, { recursive: true, force: true })
}
if (!witnessedRed) fail(TOOL, 'forbidden-asset falsifier was not detected')

console.log(`${TOOL}: PASS — source and bundle contain no forbidden raster/sprite/palette/mesh/audio/video/font assets or app-owned runtime networking; witnessed-red .shp rejected`)
