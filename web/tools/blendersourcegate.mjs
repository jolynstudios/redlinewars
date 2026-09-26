#!/usr/bin/env node
// Named editable sources, provenance, deterministic export, and a real edit on a disposable copy.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const TOOL = 'blendersourcegate'
const web = resolve(import.meta.dirname, '..'), game = resolve(web, '..')
const sources = join(game, 'art/blender/assets'), baked = join(web, '.forge/blender')
const mac = '/Applications/Blender.app/Contents/MacOS/Blender'
const blender = process.env.BLENDER_BIN || (existsSync(mac) ? mac : 'blender')
const manifest = JSON.parse(readFileSync(join(baked, 'manifest.json'), 'utf8'))
const catalog = JSON.parse(readFileSync(join(web, 'src/core/ra-visual-manifest.json'), 'utf8'))
const hidden = new Set(['camera', 'camera.paradrop', 'camera.spyplane', 'sonar', 'mpspawn', 'waypoint'])
const expected = Object.entries(catalog.actors).filter(([id, a]) => a.renderable && a.slot && !hidden.has(id)).map(([id]) => id).sort()
const files = readdirSync(sources).filter(name => name.endsWith('.blend')).map(name => name.slice(0, -6)).sort()
// A damage variant is a CONDITION of an actor, not an actor. `damage_states.py` cuts
// `<actor>.d1`..`.d5` from the parent scene for the five rungs of OpenRA's own DamageState
// enum, and they must never be catalogued as actors — the simulation would then think the
// game had five more units. Partition them out and check the relationship instead, derived
// from the parent name rather than from a list of variants that would go stale silently.
const damageVariant = /^(.+)\.d([1-5])$/
const variants = files.filter(name => damageVariant.test(name))
const actors = files.filter(name => !damageVariant.test(name))
assert.deepEqual(actors, expected, 'each visible actor needs its own canonically named .blend source')
for (const name of variants) {
	const parent = damageVariant.exec(name)[1]
	assert.ok(expected.includes(parent), `damage variant ${name} has no catalogued parent actor ${parent}`)
	assert.ok(files.includes(parent), `damage variant ${name} has no parent source ${parent}.blend`)
}
assert.equal(manifest.sourceKind, 'saved-blender-scenes', 'shipping pack must be exported from the saved sources')
const sourceHashes = new Map(), aggregate = createHash('sha256')
for (const id of expected) {
    const path = join(sources, `${id}.blend`), sha = hash(readFileSync(path)), entry = manifest.assets[id]
    sourceHashes.set(id, sha)
    assert.equal(entry.sourcePath, `art/blender/assets/${id}.blend`, `${id}: canonical source provenance`)
    assert.equal(entry.sourceSha256, sha, `${id}: exported pack is stale relative to its saved source`)
    aggregate.update(id + '\0' + sha + '\n')
}
assert.equal(manifest.sourcesSha256, aggregate.digest('hex'))
const temp = mkdtempSync(join(tmpdir(), 'steelseed-sourcegate-'))
try {
    const sourceDir = join(temp, 'sources'), id = '2tnk'
    mkdirSync(sourceDir)
    const copy = join(sourceDir, `${id}.blend`)
    copyFileSync(join(sources, `${id}.blend`), copy)
    const before = exportCopy('before'), repeat = exportCopy('repeat')
    assert.equal(before.manifest.sha256, repeat.manifest.sha256, 'unchanged saved source exports byte-identically')
    assert.deepEqual(before.pack, repeat.pack)
    const editScript = join(temp, 'edit-copy.py')
    writeFileSync(editScript, [
        'import bpy, hashlib, json',
        'def topology():',
        "    return hashlib.sha256(json.dumps([(o.name, [tuple(v.co) for v in o.data.vertices], [tuple(p.vertices) for p in o.data.polygons]) for o in sorted(bpy.context.scene.objects, key=lambda o:o.name) if o.type == 'MESH']).encode()).hexdigest()",
        'original_topology = topology()',
        "objects = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('ss_bone') == 0 and 'ss_zone' in o]",
        "assert objects, 'test source must contain chassis geometry'",
        "obj = sorted(objects, key=lambda o: o.name)[0]",
        'obj.location.x += 0.125',
        'bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)',
        'bpy.ops.wm.open_mainfile(filepath=bpy.data.filepath, load_ui=False, use_scripts=False)',
        "assert topology() == original_topology, 'saved translation changed native mesh topology'",
    ].join('\n') + '\n')
    runBlender(['--background', copy, '--python-exit-code', '1', '--python', editScript])
    const after = exportCopy('after')
    assert.notEqual(after.manifest.assets[id].sourceSha256, before.manifest.assets[id].sourceSha256, 'saved edit changes source provenance')
    assert.notEqual(after.manifest.sha256, before.manifest.sha256, 'saved geometry edit reaches the engine mesh pack')
    assert.deepEqual(after.manifest.assets[id].rig, before.manifest.assets[id].rig, 'source export preserves explicit animation rig')
    // Vertices are deduplicated across objects by their full exported attributes.
    // Moving one part can split coincident seam vertices without changing topology.
    assert.equal(after.manifest.assets[id].triangles, before.manifest.assets[id].triangles, 'simple transform preserves evaluated triangle topology')
    const outfile = join(temp, 'decoder.mjs')
    await build({ stdin: { contents: "export { decodeBlenderAsset } from './src/units/blender-mesh.ts'", resolveDir: web, loader: 'ts' },
        bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
    const { decodeBlenderAsset } = await import(pathToFileURL(outfile))
    const decoded = decodeBlenderAsset(new Uint8Array(after.pack), after.manifest.assets[id])
    assert.ok(decoded.mesh.vertexCount > 0 && decoded.rig?.turretBones.length === 1, 'edited copy remains playable and articulated')
    for (const [id, sha] of sourceHashes)
        assert.equal(hash(readFileSync(join(sources, `${id}.blend`))), sha, `${id}: source export must not overwrite the editable source`)
    console.log(`${TOOL}: PASS — ${expected.length} named .blend sources match shipping hashes; repeat export is identical; a saved tank edit reaches a valid rigged mesh; original sources preserved`)

    function exportCopy(label) {
        const output = join(temp, label)
        runBlender(['--background', '--factory-startup', '--python-exit-code', '1', '--python',
            join(game, 'art/blender/export_assets.py'), '--', '--only', id, '--source-dir', sourceDir, '--output', output])
        return { manifest: JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')), pack: readFileSync(join(output, 'roster.ssasset')) }
    }
} finally { rmSync(temp, { recursive: true, force: true }) }

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function runBlender(args) {
    const result = spawnSync(blender, args, { cwd: game, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${TOOL}: Blender failed: ${result.stderr}\n${result.stdout}`)
}
