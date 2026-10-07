#!/usr/bin/env node
// Content digest of the files the game can load from an AppBundle: sorted
// "path<TAB>sha256" lines, as release-manifest.mjs contentDigest. Source maps and
// the build inventory (steelseed/composition.json, which lists the maps' hashes)
// carry per-build Vite asset ids, so two CI builds with identical game files
// still differ there (runs 36857076538 / 36858910179). The game never fetches
// either. cadencecomparegate records this digest for the timed bundle and the
// deploy workflow refuses to ship any other.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const skipped = path => path.endsWith('.map') || path === 'steelseed/composition.json'

function list(dir, base = dir, found = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) list(full, base, found)
		else if (entry.isFile()) found.push(relative(base, full).split(sep).join('/'))
	}
	return found
}

export function runtimeDigest(dir) {
	const hash = createHash('sha256')
	let files = 0
	for (const path of list(dir)) {
		if (skipped(path)) continue
		hash.update(`${path}\t${createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')}\n`)
		files++
	}
	assert(files > 0, `No game files under ${dir}`)
	return { files, sha256: hash.digest('hex') }
}

function assert(condition, message) { if (!condition) throw new Error(message) }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	console.log(JSON.stringify(runtimeDigest(resolve(process.argv[2] ?? '../engine/bin-browser/AppBundle'))))
