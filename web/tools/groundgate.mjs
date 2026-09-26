#!/usr/bin/env node
// STEELSEED — tools/groundgate
// Geometry-only ground-contact gate for the production units/place.ts transform.
//
// No browser, camera, depth buffer or duplicate placement maths. placeActor is bundled
// from the source file the renderer imports and exercised against analytic terrain whose
// exact contact plane is known.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ROSTER_PATH = join(WEB_ROOT, 'src', 'units', 'archetype', 'roster.json')
const PLACE_PATH = join(WEB_ROOT, 'src', 'core', 'place.ts')
const AIR_FAMILIES = new Set([3, 4]) // Family.rotorcraft, Family.fixedwing
const YAWS = Object.freeze([
	0,
	Math.PI / 8,
	Math.PI / 4,
	3 * Math.PI / 8,
	Math.PI / 2,
	3 * Math.PI / 4,
	5 * Math.PI / 4,
	7 * Math.PI / 4,
])
const ALTITUDE_M = 12
const MAX_PENETRATION_M = 0.005
const MAX_FLOAT_M = 0.015
const CONTACT_EPSILON_M = 0.020
const MIN_CONTACTS = 3
const MAX_NORMAL_ERROR_DEG = 3
const MAX_BASIS_ERROR = 1e-4

const falsifier = parseFalsifier(process.argv.slice(2))
const tmp = mkdtempSync(join(tmpdir(), 'groundgate-'))
const bundlePath = join(tmp, 'place.mjs')
let placeActor
try {
	await esbuild({
		entryPoints: [PLACE_PATH],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		outfile: bundlePath,
		logLevel: 'silent',
	})
	;({ placeActor } = await import(pathToFileURL(bundlePath).href))
} finally {
	rmSync(tmp, { recursive: true, force: true })
}

const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8'))
if (!Array.isArray(roster.slots) || roster.slots.length === 0)
	throw new Error(`groundgate: ${ROSTER_PATH} has no roster slots`)

const patches = Object.freeze([
	{
		name: 'flat',
		normalCheck: true,
		make: () => ({
			x: 0,
			z: 0,
			heightAt: () => 0,
			normal: [0, 1, 0],
		}),
	},
	{
		name: 'one-step-ramp',
		normalCheck: true,
		make: () => planarPatch(0.12, 0.035), // 0.5 m rise over a canonical 4 m run
	},
	{
		name: 'two-step-ramp',
		normalCheck: false,
		make: () => planarPatch(0.24, -0.07), // 1.0 m rise over a canonical 4 m run
	},
	{
		name: 'cliff-edge',
		normalCheck: false,
		make: (halfLen, halfWid) => {
			// A unit cannot legally straddle a §8 cliff. Put the whole support polygon on the
			// upper plateau with the discontinuity immediately beside it; this still catches
			// a sampler that reaches outside its own footprint without asking a rigid plane to
			// make three contacts across a discontinuity, which is geometrically impossible.
			const supportRadius = Math.hypot(halfLen, halfWid)
			return {
				x: supportRadius + 0.025,
				z: 0,
				heightAt: worldX => worldX >= 0 ? 1 : 0,
				normal: [0, 1, 0],
			}
		},
	},
	{
		name: 'saddle',
		normalCheck: false,
		make: (halfLen, halfWid) => {
			const radiusSq = Math.max(0.25, halfLen * halfLen + halfWid * halfWid)
			return {
				x: 0,
				z: 0,
				// Eight millimetres at the support-radius box: enough to exercise a non-plane,
				// with margin inside the 5 mm penetration / 20 mm contact tolerances a rigid
				// four-point support can satisfy.
				heightAt: (worldX, worldZ) => 0.008 * worldX * worldZ / radiusSq,
				normal: [0, 1, 0],
			}
		},
	},
])

const failures = []
const failedCases = new Set()
const metricFailures = {
	penetration: 0,
	float: 0,
	contacts: 0,
	normal: 0,
	altitude: 0,
	basis: 0,
}
const stats = {
	cases: 0,
	groundCases: 0,
	airCases: 0,
	worstPenetrationM: 0,
	worstFloatM: 0,
	minimumContacts: 4,
	maxNormalErrorDeg: 0,
	maxAltitudeErrorM: 0,
	maxAxisLengthError: 0,
	maxAxisDot: 0,
	maxDeterminantError: 0,
}
const expectedControlCases = new Set()

for (const slot of roster.slots) {
	const halfLen = Math.max(0.25, slot.lengthM * 0.5)
	const halfWid = Math.max(0.25, slot.widthM * 0.5)
	const airborne = AIR_FAMILIES.has(slot.family)
	for (const patchSpec of patches) {
		for (let yawIndex = 0; yawIndex < YAWS.length; yawIndex++) {
			const yaw = YAWS[yawIndex]
			// Real procedural meshes straddle model Y=0 inconsistently. Alternate a
			// positive and negative measured mesh bottom so the gate proves placement
			// anchors geometry rather than silently assuming the origin is the ground.
			const supportMinY = airborne ? 0 : (yawIndex & 1) === 0 ? -0.125 : 0.125
			const patch = patchSpec.make(halfLen, halfWid)
			const caseId = `${slot.name}/${patchSpec.name}/yaw-${yawIndex}`
			stats.cases++
			if (airborne) stats.airCases++
			else stats.groundCases++
			if (falsifier === 'flat' && !airborne && patchSpec.name.includes('ramp'))
				expectedControlCases.add(caseId)
			if (falsifier === 'noz' && airborne)
				expectedControlCases.add(caseId)

			const centreHeight = patch.heightAt(patch.x, patch.z)
			const placementHeightAt = falsifier === 'flat'
				? () => centreHeight
				: patch.heightAt
			const altitude = falsifier === 'noz' ? centreHeight : centreHeight + ALTITUDE_M
			const matrix = new Float32Array(16)
			placeActor(
				matrix,
				0,
				patch.x,
				patch.z,
				yaw,
				halfLen,
				halfWid,
				airborne,
				altitude,
				placementHeightAt,
				supportMinY,
			)

			checkBasis(matrix, caseId)
			if (airborne) {
				const clearance = matrix[13] - centreHeight
				const error = Math.abs(clearance - ALTITUDE_M)
				stats.maxAltitudeErrorM = Math.max(stats.maxAltitudeErrorM, error)
				if (error > MAX_PENETRATION_M)
					fail('altitude', caseId, `clearance ${fmtMm(clearance)} vs requested ${fmtMm(ALTITUDE_M)} (error ${fmtMm(error)})`)
				continue
			}

			const clearances = supportClearances(matrix, halfLen, halfWid, supportMinY, patch.heightAt)
			const minClearance = Math.min(...clearances)
			const contacts = clearances.filter(value => Math.abs(value) <= CONTACT_EPSILON_M).length
			stats.worstPenetrationM = Math.max(stats.worstPenetrationM, Math.max(0, -minClearance))
			stats.worstFloatM = Math.max(stats.worstFloatM, Math.max(0, minClearance))
			stats.minimumContacts = Math.min(stats.minimumContacts, contacts)
			if (minClearance < -MAX_PENETRATION_M)
				fail('penetration', caseId, `minimum support clearance ${fmtMm(minClearance)} < -5.000 mm`)
			if (minClearance > MAX_FLOAT_M)
				fail('float', caseId, `minimum support clearance ${fmtMm(minClearance)} > +15.000 mm`)
			if (contacts < MIN_CONTACTS)
				fail('contacts', caseId, `${contacts}/4 support points within 20 mm (${clearances.map(fmtMm).join(', ')})`)

			if (patchSpec.normalCheck) {
				const errorDeg = angleDeg([matrix[4], matrix[5], matrix[6]], patch.normal)
				stats.maxNormalErrorDeg = Math.max(stats.maxNormalErrorDeg, errorDeg)
				if (errorDeg >= MAX_NORMAL_ERROR_DEG)
					fail('normal', caseId, `contact-normal error ${errorDeg.toFixed(6)}° >= 3°`)
			}
		}
	}
}

const missedControls = [...expectedControlCases].filter(caseId => !failedCases.has(caseId))
if (falsifier !== null && missedControls.length > 0) {
	for (const caseId of missedControls.slice(0, 20))
		failures.push(`[control] ${caseId}: falsifier did not make this required case fail`)
}

const status = failures.length === 0 ? 'PASS' : 'FAIL'
console.log(
	`groundgate: ${status}${falsifier ? ` --falsify=${falsifier}` : ''} — ` +
	`${stats.cases} cases (${roster.slots.length} slots × ${patches.length} patches × ${YAWS.length} yaws; ` +
	`${stats.groundCases} ground, ${stats.airCases} air); ` +
	`penetration ${fmtMm(stats.worstPenetrationM)}, float ${fmtMm(stats.worstFloatM)}, ` +
	`min contacts ${stats.minimumContacts}/4; normal ${stats.maxNormalErrorDeg.toFixed(6)}°; ` +
	`altitude error ${fmtMm(stats.maxAltitudeErrorM)}; basis length ${stats.maxAxisLengthError.toExponential(3)}, ` +
	`dot ${stats.maxAxisDot.toExponential(3)}, det ${stats.maxDeterminantError.toExponential(3)}`,
)
if (falsifier !== null)
	console.log(`  control coverage: ${expectedControlCases.size - missedControls.length}/${expectedControlCases.size} required cases witnessed red`)
if (failures.length > 0) {
	console.error(
		`  failures: ${failures.length} assertions across ${failedCases.size} cases ` +
		`(${Object.entries(metricFailures).map(([key, value]) => `${key}=${value}`).join(', ')})`,
	)
	for (const failure of failures.slice(0, 30)) console.error(`  ${failure}`)
	if (failures.length > 30) console.error(`  ... ${failures.length - 30} more`)
}

process.exit(failures.length === 0 ? 0 : 1)

function planarPatch(gradientX, gradientZ) {
	const normal = normalise([-gradientX, 1, -gradientZ])
	return {
		x: 0,
		z: 0,
		heightAt: (worldX, worldZ) => gradientX * worldX + gradientZ * worldZ,
		normal,
	}
}

function supportClearances(matrix, halfLen, halfWid, supportMinY, heightAt) {
	const out = []
	for (const localX of [-halfLen, halfLen]) {
		for (const localZ of [-halfWid, halfWid]) {
			const worldX = matrix[12] + matrix[0] * localX + matrix[4] * supportMinY + matrix[8] * localZ
			const worldY = matrix[13] + matrix[1] * localX + matrix[5] * supportMinY + matrix[9] * localZ
			const worldZ = matrix[14] + matrix[2] * localX + matrix[6] * supportMinY + matrix[10] * localZ
			out.push(worldY - heightAt(worldX, worldZ))
		}
	}
	return out
}

function checkBasis(matrix, caseId) {
	const axes = [
		[matrix[0], matrix[1], matrix[2]],
		[matrix[4], matrix[5], matrix[6]],
		[matrix[8], matrix[9], matrix[10]],
	]
	let failed = false
	for (let i = 0; i < 3; i++) {
		const lengthError = Math.abs(Math.hypot(...axes[i]) - 1)
		stats.maxAxisLengthError = Math.max(stats.maxAxisLengthError, lengthError)
		if (lengthError > MAX_BASIS_ERROR) failed = true
		for (let j = i + 1; j < 3; j++) {
			const axisDot = Math.abs(dot(axes[i], axes[j]))
			stats.maxAxisDot = Math.max(stats.maxAxisDot, axisDot)
			if (axisDot > MAX_BASIS_ERROR) failed = true
		}
	}
	const determinant = dot(axes[0], cross(axes[1], axes[2]))
	const determinantError = Math.abs(Math.abs(determinant) - 1)
	stats.maxDeterminantError = Math.max(stats.maxDeterminantError, determinantError)
	if (determinantError > MAX_BASIS_ERROR) failed = true
	if (failed)
		fail(
			'basis',
			caseId,
			`basis error length=${stats.maxAxisLengthError.toExponential(3)} ` +
			`dot=${stats.maxAxisDot.toExponential(3)} det=${determinantError.toExponential(3)}`,
		)
}

function fail(metric, caseId, detail) {
	metricFailures[metric]++
	failedCases.add(caseId)
	failures.push(`[${metric}] ${caseId}: ${detail}`)
}

function angleDeg(a, b) {
	const cosine = Math.max(-1, Math.min(1, dot(normalise(a), normalise(b))))
	return Math.acos(cosine) * 180 / Math.PI
}

function normalise(v) {
	const length = Math.hypot(...v) || 1
	return v.map(value => value / length)
}

function dot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	]
}

function fmtMm(metres) {
	return `${(metres * 1000).toFixed(3)} mm`
}

function parseFalsifier(argv) {
	let falsifier = null
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg.startsWith('--falsify=')) falsifier = arg.slice('--falsify='.length)
		else if (arg === '--falsify') falsifier = argv[++i]
		else throw new Error(`groundgate: unknown argument '${arg}'`)
	}
	if (falsifier != null && !['flat', 'noz'].includes(falsifier))
		throw new Error(`groundgate: unknown falsifier '${falsifier}'`)
	return falsifier
}
