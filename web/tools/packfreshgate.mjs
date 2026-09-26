#!/usr/bin/env node
// The shipped pack must be the pack the current sources produce.
//
// WHY THIS EXISTS. `npm run forge` aborted on one asset -- dome's ss_rig declared 3 bones
// while 12 wind entries still pointed at bones 3..14, and export_assets.py rightly refused it.
// Because the exporter validates in id order and `dome` sorts early, every asset after it was
// never re-exported. The pack silently froze. Nothing caught it for days, because the gates
// that were watching -- blendergate above all -- count joints in the .blend SOURCES. They
// reported 1,299 moving joints and they were telling the truth about the sources. The pack
// shipped 8,740 triangles for a refinery whose source had been 9,464 for days.
//
// So this gate deliberately compares the two artifacts that drifted apart, and nothing else:
// what the manifest says it exported, against the source files as they are on disk right now.
// export_assets.py already records the evidence per asset (`sourcePath`, `sourceSha256`), so
// the check needs no Blender and costs one hash per source.
//
// The `<actor>.d1`..`.d5` damage variants are NOT part of this pack. They ship through
// `damage_states.py --export` into web/.forge/damage-states/<actor>/, each with its own
// manifest recording the parent it was authored against. A first draft of this gate asserted
// those 20 sources were "never exported" and it was simply wrong. They have their own pack, so
// this gate checks that pack against its own recorded parent instead -- which caught a real
// staleness the moment it was written correctly: dome's ladder was authored against the dome
// that existed before its flag rig was repaired.
//
// WHAT IT DOES NOT CHECK, deliberately: whether the EXPORTER changed since the pack was built.
// The manifest's exporterSha256 folds in `json.dumps(palette, sort_keys=True)`, and
// reproducing Python's float repr in JavaScript would make this gate lie in a new way rather
// than a new gate. A changed exporter is caught by forgegate loading the pack on a GPU.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const web = fileURLToPath(new URL('..', import.meta.url))
const game = join(web, '..')
const manifest = JSON.parse(readFileSync(join(web, '.forge/blender/manifest.json'), 'utf8'))
const sourceDir = join(game, 'art/blender/assets')

const sha = buffer => createHash('sha256').update(buffer).digest('hex')
const stale = []
const missing = []
const rollup = createHash('sha256')
let checked = 0

for (const [id, asset] of Object.entries(manifest.assets)) {
	if (asset.hidden) continue
	rollup.update(Buffer.concat([Buffer.from(id), Buffer.from([0]), Buffer.from(asset.sourceSha256), Buffer.from('\n')]))
	const path = join(game, asset.sourcePath ?? `art/blender/assets/${id}.blend`)
	if (!existsSync(path)) { missing.push(id); continue }
	const actual = sha(readFileSync(path))
	checked++
	if (actual !== asset.sourceSha256) stale.push({ id, packed: asset.sourceSha256.slice(0, 12), source: actual.slice(0, 12), triangles: asset.triangles })
}

// A source that exists but reaches no pack at all is the same failure wearing different
// clothes. Damage variants are excluded here because they belong to the damage pack, checked
// separately below; anything else unaccounted for is a genuine orphan.
const exported = new Set(Object.keys(manifest.assets))
const orphans = readdirSync(sourceDir)
	.filter(f => f.endsWith('.blend'))
	.map(f => f.slice(0, -6))
	.filter(id => !exported.has(id) && !/\.d[1-5]$/.test(id))

// Each damage ladder records the parent .blend it was authored against. If the parent moved,
// the ladder is describing a building that no longer exists.
const damageRoot = join(web, '.forge/damage-states')
const staleLadders = []
const ladders = existsSync(damageRoot) ? readdirSync(damageRoot) : []
for (const actor of ladders) {
	const path = join(damageRoot, actor, 'manifest.json')
	if (!existsSync(path)) continue
	const ladder = JSON.parse(readFileSync(path, 'utf8'))
	const parent = join(game, ladder.parentSourcePath)
	if (!existsSync(parent)) { staleLadders.push({ actor, reason: 'parent source is missing' }); continue }
	const actual = sha(readFileSync(parent))
	if (actual !== ladder.parentSourceSha256)
		staleLadders.push({ actor, reason: `authored against ${ladder.parentSourceSha256.slice(0, 12)}, parent is now ${actual.slice(0, 12)}`, states: ladder.states?.length ?? 0 })
}

// Menu portraits are a separate Blender render pipeline; a fresh mesh cannot prove them fresh.
const previewRoot = join(web, '.forge/blender/previews')
const previews = JSON.parse(readFileSync(join(previewRoot, 'manifest.json'), 'utf8')).portraits
const stalePreviews = Object.entries(previews).filter(([, preview]) => {
    const source = join(game, preview.source)
    return !existsSync(source) || !existsSync(join(previewRoot, preview.file)) || sha(readFileSync(source)) !== preview.sourceSha256
}).map(([actor]) => actor)
assert.deepEqual(stalePreviews, [], `menu portraits are stale; run npm run forge:previews: ${stalePreviews.join(', ')}`)
console.log(`packfreshgate: ${Object.keys(previews).length} menu portraits match their Blender sources`)

const report = { checked, stale: stale.length, missingSources: missing.length, orphanSources: orphans.length, ladders: ladders.length, staleLadders: staleLadders.length }
console.log('packfreshgate: ' + JSON.stringify(report))
for (const s of stale) console.log(`  STALE ${s.id}: pack built from ${s.packed}, source is now ${s.source} (pack ships ${s.triangles} triangles)`)
for (const id of missing) console.log(`  MISSING SOURCE ${id}`)
for (const id of orphans) console.log(`  NEVER EXPORTED ${id}`)
for (const l of staleLadders) console.log(`  STALE LADDER ${l.actor}: ${l.reason}`)

assert.deepEqual(missing, [], 'the manifest names sources that do not exist')
assert.deepEqual(orphans, [], 'a .blend under art/blender/assets was never exported into the pack')
assert.deepEqual(stale.map(s => s.id), [],
	`the shipped pack is older than its sources -- run npm run forge. Stale: ${stale.map(s => s.id).join(', ')}`)
assert.deepEqual(staleLadders.map(l => l.actor), [],
	`a damage ladder was authored against a parent that has since changed -- re-run damage_states.py --author --export for: ${staleLadders.map(l => l.actor).join(', ')}`)
assert.equal(rollup.digest('hex'), manifest.sourcesSha256,
	'manifest.sourcesSha256 does not match its own per-asset hashes; the manifest was edited by hand')
assert.ok(checked > 250, `expected the full roster, only checked ${checked}`)
console.log(`packfreshgate: PASS -- ${checked} assets, pack matches sources`)
