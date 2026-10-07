#!/usr/bin/env node
// Saved Blender environment sources must remain editable and drive the actual packed outputs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const TOOL = 'environmentsourcegate'
const web = resolve(import.meta.dirname, '..'), game = resolve(web, '..')
const sources = join(game, 'art/blender/assets/environment'), baked = join(web, '.forge/environment')
const props = ['ore', 'gems', 'grass', 'grass-lod1', 'grass-lod2', 'rain', 'snow'], materialFile = 'material-library.blend'
const names = [...props.map(id => `${id}.blend`), materialFile].sort()
assert.deepEqual(readdirSync(sources).filter(name => name.endsWith('.blend')).sort(), names)
const hashes = new Map(names.map(name => [name, hash(readFileSync(join(sources, name)))]))
const propManifest = readJson(join(baked, 'props.json')), materialManifest = readJson(join(baked, 'materials.json'))
assert.equal(propManifest.sourceKind, 'saved-blender-scenes')
assert.equal(materialManifest.sourceKind, 'saved-blender-material-graphs')
assert.deepEqual(Object.keys(propManifest.assets).sort(), [...props].sort())
for (const id of props) {
    assert.equal(propManifest.assets[id].sourcePath, `art/blender/assets/environment/${id}.blend`)
    assert.equal(propManifest.assets[id].sourceSha256, hashes.get(`${id}.blend`), `${id}: saved source and packed prop disagree`)
}
assert.equal(materialManifest.sourcePath, `art/blender/assets/environment/${materialFile}`)
assert.equal(materialManifest.sourceSha256, hashes.get(materialFile), 'terrain bake must match its saved material graphs')
assert.equal(materialManifest.surfaces.length, 13)
verifyPack(join(baked, 'props.ssasset.gz'), propManifest)
verifyPack(join(baked, 'terrain.sspbr.gz'), materialManifest)
const mac = '/Applications/Blender.app/Contents/MacOS/Blender'
const blender = process.env.BLENDER_BIN || (existsSync(mac) ? mac : 'blender')
const temp = mkdtempSync(join(tmpdir(), 'steelseed-environment-sourcegate-'))
try {
    const copied = join(temp, 'sources'); mkdirSync(copied)
    for (const name of names) copyFileSync(join(sources, name), join(copied, name))
    const beforeProps = exportCopy('props-before', ['--props-only'], 'props')
    const before = exportCopy('material-before', ['--only-material', 'soil', '--size', '32'], 'materials')
    const repeat = exportCopy('material-repeat', ['--only-material', 'soil', '--size', '32'], 'materials')
    assert.deepEqual(before.pack, repeat.pack, 'unchanged saved node graph rebakes deterministically')
    const edit = join(temp, 'edit-copies.py')
    writeFileSync(edit, [
        'import bpy',
        `bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(join(copied, 'ore.blend'))})`,
        "objects = [o for o in bpy.context.scene.objects if o.type == 'MESH' and 'ss_zone' in o]",
        "assert objects, 'ore source needs actual geometry'",
        "sorted(objects, key=lambda o: o.name)[0].location.x += 0.125",
        'bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)',
        `bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(join(copied, materialFile))})`,
        "mat = bpy.data.materials['STEELSEED / soil']",
        "albedo = mat.node_tree.nodes['Natural albedo']",
        'albedo.inputs[1].default_value = (0.65, 0.10, 0.05, 1)',
        'albedo.inputs[2].default_value = (0.95, 0.40, 0.20, 1)',
        "rough = mat.node_tree.nodes['Terrain PBR'].inputs['Roughness']",
        'for link in list(rough.links): mat.node_tree.links.remove(link)',
        'rough.default_value = 0.43',
        "mat.node_tree.nodes['Terrain PBR'].inputs['Metallic'].default_value = 0.25",
        "mat['ss_tile_metres'] = 6.0; mat['ss_relief_metres'] = 0.07",
        'bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)',
    ].join('\n') + '\n')
    runBlender(['--background', '--factory-startup', '--python-exit-code', '1', '--python', edit])
    const afterProps = exportCopy('props-after', ['--props-only'], 'props')
    const after = exportCopy('material-after', ['--only-material', 'soil', '--size', '32'], 'materials')
    assert.notEqual(beforeProps.manifest.assets.ore.sha256, afterProps.manifest.assets.ore.sha256, 'saved ore mesh edit reaches prop pack')
    for (const id of props.filter(id => id !== 'ore'))
        assert.equal(beforeProps.manifest.assets[id].sha256, afterProps.manifest.assets[id].sha256, `${id}: unrelated prop geometry stays identical`)
    assert.notEqual(before.manifest.sourceSha256, after.manifest.sourceSha256)
    assert.notDeepEqual(channel(before, 0), channel(after, 0), 'saved albedo-node edit changes packed terrain pixels')
    const orm = channel(after, 2)
    assert.ok(Math.abs(orm[0] - 0.43 * 255) < 1, 'saved unlinked roughness reaches packed roughness')
    assert.ok(Math.abs(orm[1] - 0.25 * 255) < 1, 'saved metalness reaches packed metalness')
    assert.equal(after.manifest.surfaces[0].tileMeters, 6)
    assert.equal(after.manifest.surfaces[0].heightRange, 0.07)
    const outfile = join(temp, 'decoder.mjs')
    await build({ stdin: { contents: "export { decodeBlenderAsset } from './src/units/blender-mesh.ts'", resolveDir: web, loader: 'ts' },
        bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
    const { decodeBlenderAsset } = await import(pathToFileURL(outfile))
    for (const id of props) {
        const decoded = decodeBlenderAsset(new Uint8Array(afterProps.pack), afterProps.manifest.assets[id])
        assert.ok(decoded.mesh.vertexCount > 0, `${id}: saved edited pack remains valid runtime geometry`)
    }
    for (const [name, sha] of hashes)
        assert.equal(hash(readFileSync(join(sources, name))), sha, `${name}: canonical source must not be overwritten by export/bake`)
    console.log(`${TOOL}: PASS — eight named .blend sources match five runtime props plus two whole-card meadow LODs and 13 terrain materials; copy edits change ore geometry and albedo/roughness/metalness; tile/relief preserved; original sources unchanged`)

    function exportCopy(label, args, kind) {
        const out = join(temp, label)
        runBlender(['--background', '--factory-startup', '--python-exit-code', '1', '--python',
            join(game, 'art/blender/environment_export.py'), '--', '--source-dir', copied, '--output', out, ...args])
        const manifest = readJson(join(out, `${kind}.json`))
        const pack = verifyPack(join(out, kind === 'props' ? 'props.ssasset.gz' : 'terrain.sspbr.gz'), manifest)
        return { manifest, pack }
    }
} finally { rmSync(temp, { recursive: true, force: true }) }

function channel(result, index) {
    const range = result.manifest.surfaces[0].mips[0][index]
    return result.pack.subarray(range.offset, range.offset + range.bytes)
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function verifyPack(path, manifest) {
    const compressed = readFileSync(path), pack = gunzipSync(compressed)
    assert.equal(compressed.length, manifest.storedBytes)
    assert.equal(pack.length, manifest.bytes)
    assert.equal(hash(pack), manifest.sha256)
    return pack
}
function runBlender(args) {
    const result = spawnSync(blender, args, { cwd: game, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${TOOL}: Blender failed: ${result.stderr}\n${result.stdout}`)
}
