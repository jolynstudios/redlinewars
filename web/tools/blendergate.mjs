#!/usr/bin/env node
// The shipped decoder, every catalog entry, integrity failures and actual skin motion.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const web = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(web, '.forge/blender/manifest.json')))
const roster = JSON.parse(readFileSync(join(web, 'src/core/ra-visual-manifest.json')))
const pack = new Uint8Array(readFileSync(join(web, '.forge/blender/roster.ssasset')))
const temp = mkdtempSync(join(tmpdir(), 'steelseed-blendergate-'))
try {
	const outfile = join(temp, 'decoder.mjs')
	await build({ stdin: { contents: "export { decodeBlenderAsset } from './src/units/blender-mesh.ts'; export { computeWorldTransforms, computeSkinMatrices, setBoneAngle } from './src/geo/rig.ts'", resolveDir: web, loader: 'ts' },
		bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, logLevel: 'silent' })
	const api = await import(pathToFileURL(outfile).href)
	assert.equal(createHash('sha256').update(pack).digest('hex'), manifest.sha256)
	assert.equal(pack.length, manifest.bytes)
	const compressed = readFileSync(join(web, '.forge/blender/roster.ssasset.gz'))
	assert.equal(manifest.compression, 'gzip')
	assert.equal(compressed.length, manifest.storedBytes)
	assert.deepEqual(new Uint8Array(gunzipSync(compressed)), pack, 'shipping gzip must contain the validated meshes')
	const expected = Object.entries(roster.actors).filter(([, a]) => a.renderable && a.slot).map(([name]) => name).sort()
	assert.deepEqual(Object.keys(manifest.assets).sort(), expected, 'every actor must have an explicit asset or hidden entry')
	let loaded = 0, hidden = 0, articulated = 0, triangles = 0, cursor = 0
	for (const name of expected) {
		const entry = manifest.assets[name]
		if (entry.hidden) { hidden++; continue }
		assert.equal(entry.offset, cursor, `${name}: pack overlap or gap`); cursor += entry.bytes
		const bytes = pack.subarray(entry.offset, entry.offset + entry.bytes)
		assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, name)
		const { mesh, rig } = api.decodeBlenderAsset(pack, entry)
		triangles += mesh.triangleCount; loaded++
		for (let v = 0; v < mesh.vertexCount; v++) {
			const n = mesh.normals.subarray(v * 3, v * 3 + 3), t = mesh.tangents.subarray(v * 4, v * 4 + 3)
			assert.ok(Math.abs(Math.hypot(...n) - 1) < .005, `${name}: unit normal`)
			assert.ok(Math.abs(n[0]*t[0] + n[1]*t[1] + n[2]*t[2]) < .005, `${name}: orthogonal tangent`)
		}
		if (!name.includes('husk')) assert.equal(rig?.turretBones.length ?? 0, roster.actors[name].slot.turrets.length, `${name}: authoritative turret count`)
		if (!rig) continue
		const pose = rig.skeleton.createPose(), world = rig.skeleton.createMatrixBuffer(), matrices = rig.skeleton.createMatrixBuffer()
		for (const bone of [...rig.turretBones, ...rig.wheelBones, ...rig.legBones, ...(rig.rotorBones ?? []), ...(rig.windBones ?? []), ...(rig.oscillatorBones ?? [])]) {
			pose.resetToBind(); api.setBoneAngle(pose, bone, Math.PI / 2)
			api.computeWorldTransforms(pose, world); api.computeSkinMatrices(rig.skeleton, world, matrices)
			let moved = false
			for (let v = 0; v < mesh.vertexCount; v++) {
				if (mesh.skinIndices[v * 4] !== bone) continue
				const p = mesh.positions.subarray(v * 3, v * 3 + 3), o = bone * 16
				const x = matrices[o]*p[0]+matrices[o+4]*p[1]+matrices[o+8]*p[2]+matrices[o+12]
				const y = matrices[o+1]*p[0]+matrices[o+5]*p[1]+matrices[o+9]*p[2]+matrices[o+13]
				const z = matrices[o+2]*p[0]+matrices[o+6]*p[1]+matrices[o+10]*p[2]+matrices[o+14]
				if (Math.hypot(x-p[0], y-p[1], z-p[2]) > .01) { moved = true; break }
			}
			assert.ok(moved, `${name}: joint ${bone} must visibly move its geometry`); articulated++
		}
	}
	assert.equal(cursor, pack.length)
	const first = Object.values(manifest.assets).find(a => !a.hidden)
	const corrupted = pack.slice(); corrupted[first.offset+40] ^= 1
	assert.throws(() => api.decodeBlenderAsset(corrupted, first), /checksum/)
	assert.throws(() => api.decodeBlenderAsset(pack, { ...first, offset: pack.length }), /range/)
	console.log(`blendergate: PASS — ${loaded} meshes, ${hidden} invisible markers, ${articulated} moving joints, ${triangles} triangles; SHA-256 and rejection checks pass; pack ${pack.length} bytes / gzip ${compressed.length} bytes`)
} finally { rmSync(temp, { recursive: true, force: true }) }
