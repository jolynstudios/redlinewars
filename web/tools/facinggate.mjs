#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const TOOL = 'facinggate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(WEB_ROOT, 'src/core/ra-visual-manifest.json'), 'utf8'))
const unitsSource = readFileSync(join(WEB_ROOT, 'src/units/index.ts'), 'utf8')
const fxSource = readFileSync(join(WEB_ROOT, 'src/fx/index.ts'), 'utf8')
const source = await bundleSource()
const failures = []

for (let direction = 0; direction < 8; direction++) {
	const wangle = direction * 128
	const yaw = source.wangleToRadians(wangle)
	const expected = Math.PI * 0.5 + direction * Math.PI * 0.25
	if (angleError(yaw, expected) > 1e-12) failures.push(`direction ${direction}: central WAngle conversion drifted`)
	const matrix = new Float32Array(16)
	source.placeActorAtLevel(matrix, 0, 0, 0, yaw, 0)
	// Column zero is local +X transformed into render space: the one pinned forward axis.
	if (Math.abs(matrix[0] - Math.cos(expected)) > 1e-6 || Math.abs(matrix[2] + Math.sin(expected)) > 1e-6)
		failures.push(`direction ${direction}: hull local +X is not the authoritative body facing`)
}

// The cruiser is the pinned multi-turret witness. Both bones must independently compose
// from absolute OpenRA facings through hull-local yaw and land on their requested headings.
const cruiser = manifest.actors.ca.slot
const mesh = new source.Mesh()
const metadata = { rig: null, rigSkipReason: null }
source.buildUnitFromSlot(mesh, cruiser, source.rootRng('facinggate/ca'), metadata)
const rig = metadata.rig
if (!rig || rig.turretBones.length !== 2) failures.push(`ca exposes ${rig?.turretBones.length ?? 0} turret bones, expected 2`)
else {
	const bodyWangle = 384
	const turretWangles = [0, 768]
	const bodyYaw = source.wangleToRadians(bodyWangle)
	const pose = rig.skeleton.createPose()
	for (let turret = 0; turret < 2; turret++) {
		const targetYaw = source.wangleToRadians(turretWangles[turret])
		source.setBoneAngle(pose, rig.turretBones[turret], wrap(targetYaw - bodyYaw))
		const o = rig.turretBones[turret] * 4
		const qy = pose.r[o + 1]
		const qw = pose.r[o + 3]
		const localYaw = 2 * Math.atan2(qy, qw)
		if (angleError(bodyYaw + localYaw, targetYaw) > 1e-5)
			failures.push(`ca turret ${turret} does not follow its own authoritative facing`)
	}
}

if (!/actors\.facing\[i\]/.test(unitsSource) || !/actors\.turretFacing\[turretIndex\]/.test(unitsSource))
	failures.push('units no longer reads authoritative hull/turret snapshot facing fields')
if (!/absolute muzzle WPos/.test(fxSource) || !/wangleToRadians\(this\.facing\[alive\]\)/.test(fxSource))
	failures.push('muzzle/projectile FX no longer uses the authoritative event position/facing chain')

if (failures.length) {
	for (const failure of failures) console.error(`${TOOL}: FAIL — ${failure}`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — eight hull directions preserve local +X forward; cruiser hull and two turrets compose independently; authoritative FX chain retained`)

function wrap(value) { return Math.atan2(Math.sin(value), Math.cos(value)) }
function angleError(a, b) { return Math.abs(wrap(a - b)) }

async function bundleSource() {
	const tmp = mkdtempSync(join(tmpdir(), 'steelseed-facing-'))
	const outfile = join(tmp, 'source.mjs')
	try {
		await build({
			stdin: { contents: [
				"export { wangleToRadians } from './src/core/snapshot.ts'",
				"export { placeActorAtLevel } from './src/core/place.ts'",
				"export { buildUnitFromSlot } from './src/units/shapes.ts'",
				"export { Mesh } from './src/geo/mesh.ts'",
				"export { setBoneAngle } from './src/geo/rig.ts'",
				"export { rootRng } from './src/core/rng.ts'",
			].join('\n'), resolveDir: WEB_ROOT, sourcefile: 'facing-entry.ts', loader: 'ts' },
			bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile, logLevel: 'silent',
		})
		return await import(pathToFileURL(outfile).href)
	} finally { rmSync(tmp, { recursive: true, force: true }) }
}
