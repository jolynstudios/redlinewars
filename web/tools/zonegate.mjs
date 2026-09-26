#!/usr/bin/env node
// STEELSEED — tools/zonegate
// Verifies material-zone coverage on the exact mesh and GPU packing path used by units.
//
// This is deliberately not an SDF-region counter. A region can be large in its source tree
// and still claim no finished-surface vertices after welding, filleting and meshing. The gate
// reads the zone byte at the production offset (mesh.ts ZONE_BYTE_OFFSET) — the value the shader receives.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'zonegate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ROSTER_PATH = join(WEB_ROOT, 'src', 'units', 'archetype', 'roster.json')
const MINORITY_FLOOR = numberFlag('minority', 0.03)

if (!(MINORITY_FLOOR > 0 && MINORITY_FLOOR < 0.5)) {
	console.error(`${TOOL}: --minority must be greater than 0 and less than 0.5`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'zonegate-'))
const bundlePath = join(tmp, 'zonegate-source.mjs')
let source
try {
	await esbuild({
		stdin: {
			contents: [
				"export { buildUnitFromSlot } from './src/units/shapes.ts'",
				"export { Mesh, ZONE_BYTE_OFFSET } from './src/geo/mesh.ts'",
				"export { rootRng } from './src/core/rng.ts'",
				"export { Family } from './src/units/archetype/params.ts'",
				"export { Zone, ZoneFlag, hasZoneFlag, materialLayerOf } from './src/geo/zone.ts'",
			].join('\n'),
			resolveDir: WEB_ROOT,
			sourcefile: 'zonegate-entry.ts',
			loader: 'ts',
		},
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		outfile: bundlePath,
		logLevel: 'silent',
	})
	source = await import(pathToFileURL(bundlePath).href)
} finally {
	rmSync(tmp, { recursive: true, force: true })
}

const { buildUnitFromSlot, Mesh, rootRng, Family, Zone, ZoneFlag, hasZoneFlag, materialLayerOf, ZONE_BYTE_OFFSET } = source
const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8'))
	if (!Array.isArray(roster.slots) || roster.slots.length === 0)
		throw new Error(`${TOOL}: ${ROSTER_PATH} has no roster slots`)

const familyName = Object.fromEntries(Object.entries(Family).map(([name, id]) => [id, name]))
const zoneName = Object.fromEntries(Object.entries(Zone).map(([name, id]) => [id, name]))
const zoneCount = Math.max(...Object.values(Zone)) + 1
const root = rootRng('steelseed-zonegate-v1')
const scratch = new Mesh()
const failures = []
const families = new Map()
let totalVertices = 0
let emissiveVertices = 0
let overallMinority = { share: Infinity, actor: '', zone: '' }

for (const slot of roster.slots) {
	buildUnitFromSlot(scratch, slot, root.forkNamed(`units/slot/${slot.name}`))
	const gpu = scratch.toGPUBuffers()
	const packed = new Uint8Array(gpu.vertexData)
	const counts = new Uint32Array(zoneCount)
	for (let vertex = 0; vertex < gpu.vertexCount; vertex++) {
		const packedZone = packed[vertex * gpu.stride + ZONE_BYTE_OFFSET]
		if (hasZoneFlag(packedZone, ZoneFlag.emissive)) emissiveVertices++
		const zone = materialLayerOf(packedZone)
		if (zone >= zoneCount) {
			failures.push(`${slot.name}: vertex ${vertex} carries unknown material zone ${zone}`)
			continue
		}
		counts[zone]++
	}

	const present = []
	for (let zone = 0; zone < counts.length; zone++) {
		if (counts[zone] > 0) present.push(zone)
	}
	if (present.length < 2) {
		failures.push(
			`${slot.name}: ${gpu.vertexCount} uploaded vertices carry only ` +
			`${present.length === 0 ? 'no material zone' : `Zone.${zoneName[present[0]]}`}`,
		)
	}

	let minorityShare = 0
	let minorityZone = -1
	if (present.length > 0) {
		minorityZone = present.reduce((a, b) => counts[a] <= counts[b] ? a : b)
		minorityShare = counts[minorityZone] / gpu.vertexCount
		if (minorityShare < MINORITY_FLOOR) {
			failures.push(
				`${slot.name}: minority Zone.${zoneName[minorityZone]} is ` +
				`${(minorityShare * 100).toFixed(2)}% (${counts[minorityZone]}/${gpu.vertexCount}), ` +
				`below ${(MINORITY_FLOOR * 100).toFixed(1)}%`,
			)
		}
	}
	if (minorityShare < overallMinority.share) {
		overallMinority = { share: minorityShare, actor: slot.name, zone: zoneName[minorityZone] ?? 'none' }
	}

	let report = families.get(slot.family)
	if (report === undefined) {
		report = {
			name: familyName[slot.family] ?? `family-${slot.family}`,
			actors: 0,
			vertices: 0,
			counts: new Uint32Array(zoneCount),
			worstShare: Infinity,
			worstActor: '',
		}
		families.set(slot.family, report)
	}
	report.actors++
	report.vertices += gpu.vertexCount
	for (let zone = 0; zone < counts.length; zone++) report.counts[zone] += counts[zone]
	if (minorityShare < report.worstShare) {
		report.worstShare = minorityShare
		report.worstActor = slot.name
	}
	totalVertices += gpu.vertexCount
}

console.log(
	`${TOOL}: ${roster.slots.length} production meshes, ${totalVertices} uploaded vertices; ` +
	`minimum per-actor zone share ${(overallMinority.share * 100).toFixed(2)}% ` +
	`(${overallMinority.actor}, Zone.${overallMinority.zone}); floor ${(MINORITY_FLOOR * 100).toFixed(1)}%; ` +
	`${emissiveVertices} emissive-source vertices`,
)
console.log('family         actors  vertices    hull  running   optic exhaust  worst minority')
for (const [, report] of [...families].sort((a, b) => a[0] - b[0])) {
	const pct = zone => `${(report.counts[zone] / report.vertices * 100).toFixed(2)}%`.padStart(7)
	console.log(
		`${report.name.padEnd(14)} ${String(report.actors).padStart(6)} ` +
		`${String(report.vertices).padStart(9)} ${pct(Zone.hull)} ${pct(Zone.running)} ` +
		`${pct(Zone.optic)} ${pct(Zone.exhaust)}  ` +
		`${(report.worstShare * 100).toFixed(2).padStart(6)}% ${report.worstActor}`,
	)
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`  ${failure}`)
	console.error(`${TOOL}: FAIL — ${failures.length} material-zone violation(s)`)
	process.exit(1)
}

console.log(`${TOOL}: PASS — every uploaded unit mesh has at least two zones and no claimed zone below ${(MINORITY_FLOOR * 100).toFixed(1)}%`)

function numberFlag(name, fallback) {
	const prefix = `--${name}=`
	const hit = process.argv.find(arg => arg.startsWith(prefix))
	if (hit === undefined) return fallback
	const parsed = Number(hit.slice(prefix.length))
	if (!Number.isFinite(parsed)) {
		console.error(`${TOOL}: --${name} must be a finite number`)
		process.exit(2)
	}
	return parsed
}
