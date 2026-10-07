#!/usr/bin/env node
// Exercise the shipped decoder and skin matrices across a full dog gait cycle.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const web = fileURLToPath(new URL('..', import.meta.url))
const packDir = resolve(web, process.argv.find(a => a.startsWith('--pack='))?.slice(7) ?? '.forge/blender')
const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json')))
const pack = new Uint8Array(readFileSync(join(packDir, 'roster.ssasset')))
const temp = mkdtempSync(join(tmpdir(), 'steelthron-dog-skin-'))
try {
	const outfile = join(temp, 'decoder.mjs')
	await build({ stdin: { contents: "export { decodeBlenderAsset } from './src/units/blender-mesh.ts'; export { computeWorldTransforms, computeSkinMatrices, setBoneAngle } from './src/geo/rig.ts'", resolveDir: web, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	const api = await import(pathToFileURL(outfile).href)
	const { mesh, rig } = api.decodeBlenderAsset(pack, manifest.assets.dog)
	assert.ok(mesh.triangleCount >= 2500 && mesh.triangleCount <= 4200)
	assert.equal(rig.legBones.length, 4)
	const seams = new Map()
	let blended = 0
	for (let v = 0; v < mesh.vertexCount; v++) {
		const influences = Array.from(mesh.skinWeights.subarray(v*4, v*4+4)).filter(w => w > 0).length
		assert.ok(influences <= 2, 'dog skin must have only torso/leg influences')
		if (influences === 2) blended++
		const key = Array.from(mesh.positions.subarray(v*3, v*3+3), x => x.toFixed(7)).join(',')
		const row = seams.get(key) ?? []; row.push(v); seams.set(key, row)
	}
	assert.ok(blended > 100, 'joint transitions need actual blended skin')
	const duplicateVertices = [...seams.values()].filter(row => row.length > 1)
	const pose = rig.skeleton.createPose(), world = rig.skeleton.createMatrixBuffer(), matrices = rig.skeleton.createMatrixBuffer()
	const position = v => {
		const [x,y,z] = mesh.positions.subarray(v*3, v*3+3), result = [0,0,0]
		for (let j = 0; j < 4; j++) {
			const w = mesh.skinWeights[v*4+j], at = mesh.skinIndices[v*4+j]*16
			for (let axis = 0; axis < 3; axis++) result[axis] += w*(matrices[at+axis]*x+matrices[at+4+axis]*y+matrices[at+8+axis]*z+matrices[at+12+axis])
		}
		return result
	}
	let maxGap = 0
	for (let sample = 0; sample <= 24; sample++) {
		pose.resetToBind()
		for (let leg = 0; leg < 4; leg++) api.setBoneAngle(pose, rig.legBones[leg], Math.sin(sample/24*Math.PI*2+rig.legPhase[leg])*.37)
		api.computeWorldTransforms(pose, world); api.computeSkinMatrices(rig.skeleton, world, matrices)
		for (const seam of duplicateVertices) {
			const p = position(seam[0])
			for (const vertex of seam.slice(1)) {
				const q = position(vertex), gap = Math.hypot(...q.map((v,i) => v-p[i]))
				maxGap = Math.max(maxGap, gap)
				assert.ok(gap < 1e-6, `skin seam opened at gait sample ${sample}: ${gap}`)
			}
		}
	}
	console.log(`dogskingate: PASS — ${mesh.triangleCount} triangles, ${blended} blended vertices, ${duplicateVertices.length} seams across 25 gait samples, max gap ${maxGap}`)
} finally { rmSync(temp, { recursive: true, force: true }) }
