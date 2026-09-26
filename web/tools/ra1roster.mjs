#!/usr/bin/env node
// STEELSEED — tools/ra1roster
//
// RA1-identity roster completeness gate. The RA1 briefing names units, structures and
// support powers; this gate fails while any of them is absent from the visual manifest,
// not renderable, or (for identity kinds) missing its authored Blender asset.
//
//   node tools/ra1roster.mjs            hard gate: exit 1 on any failure
//   node tools/ra1roster.mjs --report   same table, always exit 0 (progress view)

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportOnly = process.argv.includes('--report')

const roster = JSON.parse(readFileSync(resolve(webRoot, 'tools/ra1-roster.json'), 'utf8'))
if (roster.schemaVersion !== 1) throw new Error(`ra1-roster.json schema ${roster.schemaVersion}, expected 1`)
const manifest = JSON.parse(readFileSync(resolve(webRoot, 'src/core/ra-visual-manifest.json'), 'utf8')).actors
const blender = JSON.parse(readFileSync(resolve(webRoot, '.forge/blender/manifest.json'), 'utf8')).assets

const rows = []
for (const entry of roster.entries) {
	const problems = []
	const inManifest = Object.prototype.hasOwnProperty.call(manifest, entry.actor)
	const actor = inManifest ? manifest[entry.actor] : null
	if (!inManifest) problems.push('missing-actor')
	else if (actor.renderable !== true) problems.push('not-renderable')
	if (inManifest && entry.identity !== 'vfx-only' && !blender[entry.actor]) problems.push('no-authored-asset')
	rows.push({ ...entry, ok: problems.length === 0, problems })
}

const pad = (value, width) => String(value).padEnd(width)
const width = Math.max(...rows.map(row => row.actor.length), 8)
let authored = 0
for (const row of rows) {
	if (row.identity !== 'vfx-only' && !row.problems.includes('no-authored-asset')) authored++
	const status = row.ok ? 'ok' : row.problems.join(',')
	console.log(`${pad(row.actor, width)}  ${pad(row.ra1, 28)} ${pad(row.kind, 9)} ${pad(row.identity, 8)} ${status}`)
}
const failed = rows.filter(row => !row.ok)
console.log(`\n${rows.length} entries, ${rows.length - failed.length} ok, ${failed.length} failed, ${authored}/${rows.filter(row => row.identity !== 'vfx-only').length} authored`)
if (failed.length && !reportOnly) {
	console.error(`ra1roster: ${failed.map(row => `${row.actor}(${row.problems.join(',')})`).join(', ')}`)
	process.exit(1)
}
