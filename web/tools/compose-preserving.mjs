#!/usr/bin/env node
// Compose without deletion: preserve immutable assets from earlier releases.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME_ROOT = resolve(WEB_ROOT, '..')
const DIST = join(WEB_ROOT, 'dist')
const APP_BUNDLE = join(GAME_ROOT, 'engine', 'bin-browser', 'AppBundle')
const TARGET = join(APP_BUNDLE, 'steelseed')
const HOST_SCRIPT = '<script type="module" src="../main.js"></script>'

const requireFile = (path, help) => {
	if (!existsSync(path)) throw new Error(`compose-preserving: missing ${path}; ${help}`)
}
requireFile(join(DIST, 'index.html'), 'run a clean web build first')
requireFile(join(APP_BUNDLE, 'main.js'), 'publish OpenRA.Browser first')
requireFile(join(APP_BUNDLE, '_framework', 'dotnet.js'), 'OpenRA AppBundle is incomplete')

mkdirSync(TARGET, { recursive: true })
for (const entry of readdirSync(DIST)) {
	if (entry === 'index.html') continue
	cpSync(join(DIST, entry), join(TARGET, entry), { recursive: true })
}

const index = readFileSync(join(DIST, 'index.html'), 'utf8')
const presentationScript = /<script type="module"[^>]*src="\.\/assets\/[^\"]+"[^>]*><\/script>/
if (!presentationScript.test(index)) throw new Error('compose-preserving: presentation entry marker is absent')
const withHost = index.replace(presentationScript, `${HOST_SCRIPT}\n\t\t$&`)
const bootHost = '<script>if(!/[?&]mode=/.test(location.search))location.replace(location.pathname+"?mode=game&platform=null"+location.hash)</script>'
const indexPath = join(TARGET, 'index.html')
writeFileSync(indexPath, withHost.includes('</head>') ? withHost.replace('</head>', `\t${bootHost}\n\t</head>`) : `${bootHost}${withHost}`)

const files = []
const visit = dir => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) visit(path)
		else if (entry.isFile()) files.push(path)
	}
}
visit(TARGET)
files.sort()
const manifest = {
	schema: 1,
	entry: 'steelseed/index.html?mode=game&platform=null',
	host: '../main.js',
	preservedOutput: true,
	files: files.map(path => ({
		path: relative(TARGET, path).replaceAll('\\', '/'),
		bytes: statSync(path).size,
		sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
	})),
}
writeFileSync(join(TARGET, 'composition.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
console.log(`compose-preserving: PASS ${manifest.files.length} files, ${bytes} bytes, no deletion -> ${TARGET}`)
