#!/usr/bin/env node
// STEELSEED — tools/skingate
// Verifies the production tracked rig, packed vertex skin channels and palette convention.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const TOOL = 'skingate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const falsify = process.argv.includes('--falsify=transpose') ? 'transpose' : null
for (const arg of process.argv.slice(2)) {
	if (arg.startsWith('--falsify=') && arg !== '--falsify=transpose')
		throw new Error(`${TOOL}: unknown ${arg}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'skingate-'))
const bundlePath = join(tmp, 'skingate-source.mjs')
await build({
	stdin: {
		contents: [
			"export { Mesh, VERTEX_STRIDE_SKINNED, SKIN_INDEX_OFFSET, SKIN_WEIGHT_OFFSET } from './src/geo/mesh.ts'",
			"export { computeSkinMatrices, computeWorldTransforms, setBoneAngle } from './src/geo/rig.ts'",
			"export { rootRng } from './src/core/rng.ts'",
			"export { buildUnitFromSlot } from './src/units/shapes.ts'",
		].join('\n'),
		resolveDir: WEB_ROOT,
		sourcefile: 'skingate-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	outfile: bundlePath,
	logLevel: 'silent',
})

const {
	Mesh,
	VERTEX_STRIDE_SKINNED,
	SKIN_INDEX_OFFSET,
	SKIN_WEIGHT_OFFSET,
	buildUnitFromSlot,
	computeSkinMatrices,
	computeWorldTransforms,
	rootRng,
	setBoneAngle,
} = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`)
const roster = JSON.parse(readFileSync(join(WEB_ROOT, 'src/units/archetype/roster.json'), 'utf8'))

const ANGLE = 0.713
const EPSILON_M = 1e-5
const MIN_TURRET_MOVEMENT_M = 0.25
const MAX_HULL_MOVEMENT_M = 1e-5
const rows = []
const failures = []
let maxErrorM = 0
let transposeMinErrorM = Infinity
let rigged = 0
let staticTracked = 0
let minTurretMovementM = Infinity
let maxTurretMovementM = 0
let maxHullMovementM = 0

for (const slot of roster.slots.filter(slot => slot.family === 0)) {
	const mesh = new Mesh()
	const metadata = { rig: null }
	buildUnitFromSlot(mesh, slot, rootRng(`skingate/${slot.name}`), metadata)
	const hasAuthoredTurret = slot.turret !== null
	if (!hasAuthoredTurret) {
		staticTracked++
		if (metadata.rig !== null) failures.push(`${slot.name}: turretless slot produced a rig`)
		if (mesh.skinned) failures.push(`${slot.name}: turretless slot took the ${VERTEX_STRIDE_SKINNED}-byte skinned stride`)
		rows.push({
			actor: slot.name,
			chassis: mesh.vertexCount,
			turret: 0,
			stride: mesh.toGPUBuffers().stride,
			maxWeight: 0,
			turretMovementM: 0,
			hullMovementM: 0,
			errorM: 0,
		})
		continue
	}

	rigged++
	const rig = metadata.rig
	if (rig === null) {
		failures.push(`${slot.name}: authored turret produced no rig`)
		continue
	}
	if (!mesh.skinned || mesh.skinIndices === null || mesh.skinWeights === null) {
		failures.push(`${slot.name}: rigged mesh has no skin channels`)
		continue
	}
	const turretBone = rig.turretBones[0]
	const packed = mesh.toGPUBuffers()
	if (packed.stride !== VERTEX_STRIDE_SKINNED) failures.push(`${slot.name}: rigged stride ${packed.stride}, expected ${VERTEX_STRIDE_SKINNED}`)
	const vertex = findRigidVertex(mesh, turretBone)
	if (vertex < 0) {
		failures.push(`${slot.name}: no vertex is rigidly captured by turret bone ${turretBone}`)
		continue
	}

	const pose = rig.skeleton.createPose()
	setBoneAngle(pose, turretBone, ANGLE)
	const world = rig.skeleton.createMatrixBuffer()
	const palette = rig.skeleton.createMatrixBuffer()
	computeWorldTransforms(pose, world)
	computeSkinMatrices(rig.skeleton, world, palette)
	if (falsify === 'transpose') transposeMatricesInPlace(palette)

	// Read the exact position, joints and UNORM8 weights out of the interleaved upload
	// buffer. This is the byte contract the GPU consumes, not the authoring arrays.
	const bytes = new Uint8Array(packed.vertexData)
	const floats = new Float32Array(packed.vertexData)
	const byteOffset = vertex * packed.stride
	const floatOffset = byteOffset / 4
	const position = [floats[floatOffset], floats[floatOffset + 1], floats[floatOffset + 2]]
	const actual = skinPackedVertex(bytes, byteOffset, position, palette)
	const expected = transformPoint(world, turretBone, transformPoint(rig.skeleton.inverseBind, turretBone, position))
	const errorM = distance(actual, expected)
	maxErrorM = Math.max(maxErrorM, errorM)
	if (falsify === 'transpose') transposeMinErrorM = Math.min(transposeMinErrorM, errorM)
	else if (errorM > EPSILON_M)
		failures.push(`${slot.name}: packed vertex ${vertex} missed expected pose by ${errorM.toExponential(3)} m`)

	// A captured vertex count is not enough: a bone with only quantisation-floor weights is
	// present but visually inert. Pose the exact packed mesh at 0° and 90° and measure what
	// moves. A working rigid turret travels on the scale of its own radius; the chassis stays
	// bit-still because maxInfluences=1 gives the welded machinery a hard boundary.
	const bindPalette = paletteAt(rig, 0)
	const quarterTurnPalette = paletteAt(rig, Math.PI * 0.5)
	let turretMovementM = 0
	let hullMovementM = 0
	let maxWeight = 0
	for (let candidate = 0; candidate < packed.vertexCount; candidate++) {
		const candidateByteOffset = candidate * packed.stride
		const candidateFloatOffset = candidateByteOffset / 4
		const candidatePosition = [
			floats[candidateFloatOffset],
			floats[candidateFloatOffset + 1],
			floats[candidateFloatOffset + 2],
		]
		const atBind = skinPackedVertex(bytes, candidateByteOffset, candidatePosition, bindPalette)
		const atQuarterTurn = skinPackedVertex(bytes, candidateByteOffset, candidatePosition, quarterTurnPalette)
		const moved = distance(atBind, atQuarterTurn)
		const primary = bytes[candidateByteOffset + SKIN_INDEX_OFFSET]
		if (primary === turretBone) turretMovementM = Math.max(turretMovementM, moved)
		else if (primary === 0) hullMovementM = Math.max(hullMovementM, moved)
		for (let influence = 0; influence < 4; influence++) {
			if (bytes[candidateByteOffset + SKIN_INDEX_OFFSET + influence] !== turretBone) continue
			maxWeight = Math.max(maxWeight, bytes[candidateByteOffset + SKIN_WEIGHT_OFFSET + influence] / 255)
		}
	}
	minTurretMovementM = Math.min(minTurretMovementM, turretMovementM)
	maxTurretMovementM = Math.max(maxTurretMovementM, turretMovementM)
	maxHullMovementM = Math.max(maxHullMovementM, hullMovementM)
	if (maxWeight < 0.25)
		failures.push(`${slot.name}: turret maximum packed weight ${maxWeight.toFixed(4)} is below 0.25`)
	if (turretMovementM < MIN_TURRET_MOVEMENT_M)
		failures.push(`${slot.name}: 90° turret movement ${turretMovementM.toFixed(4)} m is below ${MIN_TURRET_MOVEMENT_M} m`)
	if (hullMovementM > MAX_HULL_MOVEMENT_M)
		failures.push(`${slot.name}: 90° traverse moves the hull ${hullMovementM.toExponential(3)} m`)

	rows.push({
		actor: slot.name,
		chassis: rig.capturedVertices[0],
		turret: rig.capturedVertices[turretBone],
		stride: packed.stride,
		maxWeight,
		turretMovementM,
		hullMovementM,
		errorM,
	})
}

if (rigged !== 9) failures.push(`rigged tracked slots ${rigged}, expected 9`)
if (staticTracked !== 3) failures.push(`static tracked slots ${staticTracked}, expected 3`)
if (falsify === 'transpose' && !(maxErrorM > 0.01))
	failures.push(`transpose falsifier moved the worst probe only ${maxErrorM.toExponential(3)} m`)

console.log('actor                 chassis turret stride max-w turret-m hull-mm  error-mm')
for (const row of rows) {
	console.log(
		`${row.actor.padEnd(21)} ${String(row.chassis).padStart(7)} ${String(row.turret).padStart(6)} ` +
		`${String(row.stride).padStart(6)} ${row.maxWeight.toFixed(3).padStart(5)} ` +
		`${row.turretMovementM.toFixed(4).padStart(8)} ${(row.hullMovementM * 1000).toFixed(6).padStart(7)} ` +
		`${(row.errorM * 1000).toFixed(6).padStart(9)}`,
	)
}
console.log(
	`${TOOL}: ${rigged} rigged / ${staticTracked} static tracked slots; ` +
	`turret movement ${minTurretMovementM.toFixed(4)}..${maxTurretMovementM.toFixed(4)} m, ` +
	`max hull movement ${(maxHullMovementM * 1000).toFixed(6)} mm, ` +
	`max pose error ${(maxErrorM * 1000).toFixed(6)} mm` +
	(falsify === 'transpose' ? `, min transpose error ${(transposeMinErrorM * 1000).toFixed(3)} mm` : ''),
)

if (falsify === 'transpose') {
	// The control must be RED. Its non-zero exit is the witnessed failure, not a gate defect.
	console.error(`${TOOL}: FAIL — transposed palette disagrees with computeWorldTransforms`)
	process.exitCode = 1
} else if (failures.length > 0) {
	for (const failure of failures) console.error(`${TOOL}: FAIL — ${failure}`)
	process.exitCode = 1
} else {
	console.log(`${TOOL}: PASS — packed tracked vertices follow the production two-bone pose`)
}

function findRigidVertex(mesh, bone) {
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
		const o = vertex * 4
		if (mesh.skinIndices[o] === bone && mesh.skinWeights[o] > 0.999) return vertex
	}
	return -1
}

function paletteAt(rig, radians) {
	const pose = rig.skeleton.createPose()
	setBoneAngle(pose, rig.turretBones[0], radians)
	const world = rig.skeleton.createMatrixBuffer()
	const palette = rig.skeleton.createMatrixBuffer()
	computeWorldTransforms(pose, world)
	computeSkinMatrices(rig.skeleton, world, palette)
	return palette
}

function skinPackedVertex(bytes, byteOffset, position, palette) {
	const out = [0, 0, 0]
	for (let influence = 0; influence < 4; influence++) {
		const joint = bytes[byteOffset + SKIN_INDEX_OFFSET + influence]
		const weight = bytes[byteOffset + SKIN_WEIGHT_OFFSET + influence] / 255
		if (weight === 0) continue
		const point = transformPoint(palette, joint, position)
		out[0] += point[0] * weight
		out[1] += point[1] * weight
		out[2] += point[2] * weight
	}
	return out
}

function transformPoint(matrices, matrix, point) {
	const o = matrix * 16
	return [
		matrices[o] * point[0] + matrices[o + 4] * point[1] + matrices[o + 8] * point[2] + matrices[o + 12],
		matrices[o + 1] * point[0] + matrices[o + 5] * point[1] + matrices[o + 9] * point[2] + matrices[o + 13],
		matrices[o + 2] * point[0] + matrices[o + 6] * point[1] + matrices[o + 10] * point[2] + matrices[o + 14],
	]
}

function transposeMatricesInPlace(matrices) {
	for (let base = 0; base < matrices.length; base += 16) {
		for (let row = 0; row < 4; row++) {
			for (let column = row + 1; column < 4; column++) {
				const a = base + column * 4 + row
				const b = base + row * 4 + column
				const value = matrices[a]
				matrices[a] = matrices[b]
				matrices[b] = value
			}
		}
	}
}

function distance(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
