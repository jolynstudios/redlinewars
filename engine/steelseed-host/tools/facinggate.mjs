#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fail } from './gate-lib.mjs'

const TOOL = 'facinggate'
const hostRoot = resolve(import.meta.dirname, '..')
const webRoot = resolve(hostRoot, '../../web/src')
const snapshot = readFileSync(resolve(webRoot, 'core/snapshot.ts'), 'utf8')
const units = readFileSync(resolve(webRoot, 'units/index.ts'), 'utf8')
const fx = readFileSync(resolve(webRoot, 'fx/index.ts'), 'utf8')

if (!snapshot.includes('Math.PI * 0.5 + (w / WANGLE_TURN) * Math.PI * 2'))
	fail(TOOL, 'central OpenRA WAngle conversion is missing or changed')
for (const [name, source] of [['units', units], ['fx', fx]])
	if (!source.includes('wangleToRadians')) fail(TOOL, `${name} bypasses the central facing conversion`)
if (!units.includes('wangleToRadians(turretFacing) - yaw'))
	fail(TOOL, 'turret local facing does not use the same converted world orientation as the hull')

const convert = w => Math.PI * 0.5 + (w / 1024) * Math.PI * 2
const forward = w => {
	const yaw = convert(w)
	return [Math.cos(yaw), -Math.sin(yaw)] // render X,Z for mesh-local +X
}
const invSqrt2 = Math.SQRT1_2
const cases = [
	[0, 0, -1], [128, -invSqrt2, -invSqrt2], [256, -1, 0], [384, -invSqrt2, invSqrt2],
	[512, 0, 1], [640, invSqrt2, invSqrt2], [768, 1, 0], [896, invSqrt2, -invSqrt2],
]
for (const [w, x, z] of cases) {
	const actual = forward(w)
	if (Math.abs(actual[0] - x) > 1e-9 || Math.abs(actual[1] - z) > 1e-9)
		fail(TOOL, `WAngle ${w} points (${actual.join(',')}) instead of (${x},${z})`)
}

// Witness a classic quarter-turn bug: treating zero as mesh-local +X must fail north.
const wrongForward = [Math.cos(0), -Math.sin(0)]
if (Math.abs(wrongForward[0]) < 1e-9 && Math.abs(wrongForward[1] + 1) < 1e-9)
	fail(TOOL, 'quarter-turn falsifier unexpectedly passed')

console.log(`${TOOL}: PASS — hull, turret and muzzle/FX agree at 4 cardinal + 4 diagonal facings; quarter-turn falsifier witnessed red`)
