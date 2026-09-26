#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const TOOL = 'runninggeargate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(WEB_ROOT, 'src/core/ra-visual-manifest.json'), 'utf8'))
const source = await bundleSource()
const failures = []
let actors = 0
let wheels = 0
let composed = 0
for (const [name, actor] of Object.entries(manifest.actors)) {
	if (!actor.renderable || actor.slot.family !== source.Family.wheeled) continue
	actors++
	const mesh = new source.Mesh()
	const metadata = { rig: null, rigSkipReason: null }
	source.buildUnitFromSlot(mesh, actor.slot, source.rootRng(`runninggear/${name}`), metadata)
	const rig = metadata.rig
	const expectedWheels = Math.max(source.deriveChassis(actor.slot).axles, 2) * 2
	if (!rig) { failures.push(`${name}: no composite rig`); continue }
	if (rig.wheelBones.length !== expectedWheels)
		failures.push(`${name}: ${rig.wheelBones.length} wheel bones, expected ${expectedWheels}`)
	for (let index = 0; index < rig.wheelBones.length; index++) {
		const bone = rig.wheelBones[index]
		const radius = rig.wheelRadii[index]
		wheels++
		if (!(radius > 0)) failures.push(`${name}: wheel ${index} has non-positive geometric radius`)
		if (!(rig.capturedVertices[bone] > 0)) failures.push(`${name}: wheel ${index} owns no rendered geometry`)
		const rest = rig.skeleton.createPose()
		const forward = rig.skeleton.createPose()
		const reverse = rig.skeleton.createPose()
		source.setBoneAngle(forward, bone, 2 / radius)
		source.setBoneAngle(reverse, bone, -2 / radius)
		const o = bone * 4
		if (!sameQuat(rest.r, o, rig.skeleton.bindR, o)) failures.push(`${name}: stationary wheel ${index} moved`)
		if (Math.abs(forward.r[o + 2] + reverse.r[o + 2]) > 1e-5 || Math.abs(forward.r[o + 3] - reverse.r[o + 3]) > 1e-5)
			failures.push(`${name}: wheel ${index} does not reverse signed distance/radius rotation`)
	}
	if (actor.slot.turret !== null) {
		if (rig.turretBones.length === 0) failures.push(`${name}: turreted wheeled actor has no turret bone`)
		else {
			composed++
			const pose = rig.skeleton.createPose()
			const turretBone = rig.turretBones[0]
			source.setBoneAngle(pose, turretBone, 0.63)
			const turretQuat = pose.r.slice(turretBone * 4, turretBone * 4 + 4)
			for (let index = 0; index < rig.wheelBones.length; index++)
				source.setBoneAngle(pose, rig.wheelBones[index], 1.75 / rig.wheelRadii[index])
			for (let k = 0; k < 4; k++)
				if (Math.abs(pose.r[turretBone * 4 + k] - turretQuat[k]) > 1e-6)
					failures.push(`${name}: wheel pose overwrote the previously composed turret pose`)
		}
	}
}
if (actors !== 11) failures.push(`tested ${actors} wheeled actors, expected pinned 11`)
if (failures.length) {
	for (const failure of failures) console.error(`${TOOL}: FAIL — ${failure}`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — ${actors} wheeled actors, ${wheels} individually coupled wheels; ` +
	`signed travel/radius and stationary poses verified; ${composed} turret+wheel rigs share one pose`)

function sameQuat(a, ao, b, bo) {
	for (let k = 0; k < 4; k++) if (Math.abs(a[ao + k] - b[bo + k]) > 1e-7) return false
	return true
}

async function bundleSource() {
	const tmp = mkdtempSync(join(tmpdir(), 'steelseed-runninggear-'))
	const outfile = join(tmp, 'source.mjs')
	try {
		await build({
			stdin: { contents: [
				"export { buildUnitFromSlot } from './src/units/shapes.ts'",
				"export { deriveChassis, Family } from './src/units/archetype/params.ts'",
				"export { Mesh } from './src/geo/mesh.ts'",
				"export { setBoneAngle } from './src/geo/rig.ts'",
				"export { rootRng } from './src/core/rng.ts'",
			].join('\n'), resolveDir: WEB_ROOT, sourcefile: 'runninggear-entry.ts', loader: 'ts' },
			bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile, logLevel: 'silent',
		})
		return await import(pathToFileURL(outfile).href)
	} finally { rmSync(tmp, { recursive: true, force: true }) }
}
