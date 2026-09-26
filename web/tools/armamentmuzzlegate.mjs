#!/usr/bin/env node
// STEELSEED — tools/armamentmuzzlegate
//
// A Mammoth fires two weapons and the flash has to leave the tube that fired, not a
// neighbour. This gate checks both facts against the same functions the renderer runs.
//
//   1. 4tnk armament 0 is 120mm (cannon), armament 1 is MammothTusk (rocket).
//   2. A Y-only lift of the sprite muzzle leaves the flash beside the authored barrel;
//      the 3-D transform lands on the barrel tip, including after a 90° turret traverse.
//
// Usage: node tools/armamentmuzzlegate.mjs

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { readFileSync } from 'node:fs'

const TOOL = 'armamentmuzzlegate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const problems = []
const note = m => problems.push(m)

const manifest = JSON.parse(readFileSync(join(WEB, 'src/weapon-visual-manifest.json'), 'utf8'))
const visuals = JSON.parse(readFileSync(join(WEB, 'src/core/ra-visual-manifest.json'), 'utf8'))
const anchors = JSON.parse(readFileSync(join(WEB, '.forge/blender/muzzle-anchors.json'), 'utf8'))

const styles = new Map(manifest.profiles.map(p => [p.weapon, p.style]))
const tank = visuals.actors['4tnk']?.slot
if (!tank) note('4tnk slot missing from ra-visual-manifest')
else {
	const primary = tank.armaments?.[0]
	const secondary = tank.armaments?.[1]
	if (primary?.weapon !== '120mm') note(`4tnk primary is ${primary?.weapon}, expected 120mm`)
	if (secondary?.weapon !== 'MammothTusk') note(`4tnk secondary is ${secondary?.weapon}, expected MammothTusk`)
	const cannon = styles.get('120mm')
	const tusk = styles.get('MammothTusk')
	if (cannon?.family !== 'cannon') note(`120mm family is ${cannon?.family}, expected cannon`)
	if (tusk?.family !== 'rocket') note(`MammothTusk family is ${tusk?.family}, expected rocket`)
	if (cannon?.muzzle?.style === tusk?.muzzle?.style)
		note('120mm and MammothTusk share a muzzle style; they must look different')
}

const tmp = mkdtempSync(join(tmpdir(), 'armamentmuzzle-'))
const outfile = join(tmp, 'muzzle.mjs')
await esbuild({
	entryPoints: [join(WEB, 'src/units/muzzle.ts')],
	outfile,
	bundle: true,
	format: 'esm',
	platform: 'node',
	logLevel: 'silent',
})
const { resolveMuzzleLocal, transformMuzzleWorld } = await import(pathToFileURL(outfile).href)

const bind = {
	ax: anchors.actors['4tnk'].anchor[0],
	ay: anchors.actors['4tnk'].anchor[1],
	az: anchors.actors['4tnk'].anchor[2],
	dual: new Uint8Array([1, 1]),
	armX: new Float32Array([0.87890625, -0.0830078125]),
	armY: new Float32Array([0.33203125, 0.33203125]),
	armZ: new Float32Array([0.17578125, 0.375]),
	armTurret: new Uint8Array([0, 0]),
	turretOx: new Float32Array([0, 0]),
	turretOy: new Float32Array([0, 0]),
	turretOz: new Float32Array([0, 0]),
	weapons: ['120mm', 'MammothTusk'],
}

const local = new Float32Array(3)
resolveMuzzleLocal(bind, 0, -0.2, local)
if (Math.abs(local[0] - bind.ax) > 1e-6 || Math.abs(local[1] - bind.ay) > 1e-6)
	note(`primary local ${Array.from(local)} is not the authored barrel ${[bind.ax, bind.ay, bind.az]}`)
if (local[2] * bind.az < 0) note('primary barrel pick flipped the measured tube against simLocalZ')

resolveMuzzleLocal(bind, 1, 0.4, local)
if (Math.abs(local[0] - bind.armX[1]) > 1e-6)
	note(`tusk local forward ${local[0]} is not the launcher mount ${bind.armX[1]}`)
if (Math.abs(local[1] - bind.ay) > 1e-6)
	note(`tusk height ${local[1]} was not lifted onto the authored barrel`)

const identity = new Float32Array([
	1, 0, 0, 0,
	0, 1, 0, 0,
	0, 0, 1, 0,
	10, 2, 4, 1,
])
const world = new Float32Array(6)
resolveMuzzleLocal(bind, 0, -0.2, local)
transformMuzzleWorld(identity, 0, 0, local[0], local[1], local[2], world)
const expected = [10 + bind.ax, 2 + bind.ay, 4 + local[2]]
if (Math.hypot(world[0] - expected[0], world[1] - expected[1], world[2] - expected[2]) > 1e-5)
	note(`identity transform landed at ${Array.from(world).slice(0, 3)}, expected ${expected}`)

transformMuzzleWorld(identity, 0, Math.PI / 2, bind.ax, bind.ay, 0, world)
const turned = [10 + 0, 2 + bind.ay, 4 - bind.ax]
if (Math.hypot(world[0] - turned[0], world[1] - turned[1], world[2] - turned[2]) > 1e-5)
	note(`90° turret transform landed at ${Array.from(world).slice(0, 3)}, expected ${turned}`)

transformMuzzleWorld(identity, 0, Math.PI / 2, 0.75 + 0.47, 2.12, 0, world, 0, 0.75, 0.12, 0)
const pivoted = [10 + 0.75, 2 + 2.12, 4 - 0.47]
if (Math.hypot(world[0] - pivoted[0], world[1] - pivoted[1], world[2] - pivoted[2]) > 1e-5)
	note(`turret-pivot 90° landed at ${Array.from(world).slice(0, 3)}, expected ${pivoted} (must rotate about the turret, not the hull)`)

const liftOnly = [
	10 + bind.armX[0],
	2 + bind.ay,
	4 + bind.armZ[0],
]
const authored = [10 + bind.ax, 2 + bind.ay, 4 + bind.az]
const liftErr = Math.hypot(liftOnly[0] - authored[0], liftOnly[1] - authored[1], liftOnly[2] - authored[2])
if (!(liftErr > 0.2))
	note(`Y-only lift error is ${liftErr.toFixed(3)} m; expected the known ~0.25 m lateral miss`)

if (problems.length) {
	console.error(`${TOOL}: FAILED`)
	for (const p of problems) console.error('  ' + p)
	process.exit(1)
}
console.log(`${TOOL}: ok  4tnk 120mm/MammothTusk distinct, barrel transform on the tube`)
writeFileSync(join(tmp, 'ok'), '')
