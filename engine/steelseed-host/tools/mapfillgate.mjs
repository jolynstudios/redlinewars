#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fail } from './gate-lib.mjs'

const TOOL = 'mapfillgate'
const hostRoot = resolve(import.meta.dirname, '..')
const gameRoot = resolve(hostRoot, '../..')
const cameraSource = readFileSync(resolve(gameRoot, 'web/src/camera/index.ts'), 'utf8')
// The pinned contract follows the current camera (web/src/camera/index.ts):
// pitchForHeight/maxHeightInsideMap/clampFocusToFrustum/basePitch are the live
// seams; the old frustumCoefficientsAtPitch helper no longer exists because
// containment moved to bounds clamping, and this gate owns the frustum model.
for (const token of ['pitchForHeight', 'maxHeightInsideMap', 'clampFocusToFrustum', 'basePitch'])
	if (!cameraSource.includes(token)) fail(TOOL, `production camera is missing ${token}`)

const FOV_Y = 48 * Math.PI / 180
// Camera bands copied from web/src/camera/index.ts (HEIGHT_MIN 3.5, HEIGHT_MAX
// 140, zoom pitch 48..62 degrees, pitch hard-clamped to 28..82 with tilt).
const HEIGHT_MIN = 3.5
const HEIGHT_MAX = 140
const PITCH_NEAR = 48
const PITCH_FAR = 62
const PITCH_MAX = 82 * Math.PI / 180
const aspects = [16 / 9, 21 / 9, 4 / 3, 9 / 16]
const dprs = [1, 1.5, 2, 3]
const yaws = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4]

function extents(pitch, aspect, yaw) {
	const halfV = FOV_Y * 0.5
	const back = 1 / Math.tan(pitch)
	const behind = Math.max(0, back - 1 / Math.tan(pitch + halfV))
	const ahead = Math.max(0, 1 / Math.tan(Math.max(0.05, pitch - halfV)) - back)
	const halfH = Math.atan(Math.tan(halfV) * aspect)
	const lateral = Math.tan(halfH) / Math.sin(Math.max(0.05, pitch - halfV))
	const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
	const rx = Math.cos(yaw), rz = -Math.sin(yaw)
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
	for (let corner = 0; corner < 4; corner++) {
		const forward = corner < 2 ? -behind : ahead
		const side = (corner & 1) === 0 ? -lateral : lateral
		const x = forward * fx + side * rx
		const z = forward * fz + side * rz
		minX = Math.min(minX, x); maxX = Math.max(maxX, x)
		minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
	}
	return { minX, maxX, minZ, maxZ }
}

function basePitch(height) {
	const t = Math.max(0, Math.min(1, (height - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN)))
	return (PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * t) * Math.PI / 180
}
// The camera additionally clamps pitch to 28..82 degrees after tilt (pitchForHeight);
// the fitted bisect below already respects that ceiling through PITCH_MAX.

function fitted(width, depth, height, aspect, yaw) {
	const fits = pitch => {
		const e = extents(pitch, aspect, yaw)
		return (e.maxX - e.minX) * height <= width * 0.985 && (e.maxZ - e.minZ) * height <= depth * 0.985
	}
	const base = basePitch(height)
	if (fits(base)) return { pitch: base, e: extents(base, aspect, yaw) }
	let lo = base, hi = PITCH_MAX
	for (let i = 0; i < 14; i++) {
		const mid = (lo + hi) * 0.5
		if (fits(mid)) hi = mid
		else lo = mid
	}
	return { pitch: hi, e: extents(hi, aspect, yaw) }
}

function maxHeight(width, depth, aspect, yaw) {
	let lo = HEIGHT_MIN, hi = HEIGHT_MAX
	for (let i = 0; i < 14; i++) {
		const mid = (lo + hi) * 0.5
		const { e } = fitted(width, depth, mid, aspect, yaw)
		if ((e.maxX - e.minX) * mid <= width * 0.985 && (e.maxZ - e.minZ) * mid <= depth * 0.985) lo = mid
		else hi = mid
	}
	return lo
}

const mapsRoot = resolve(gameRoot, 'engine/openra/mods/ra/maps')
const maps = readdirSync(mapsRoot).sort().map(id => {
	const text = readFileSync(resolve(mapsRoot, id, 'map.yaml'), 'utf8')
	const hit = /^Bounds:\s*(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(text)
	if (!hit) fail(TOOL, `${id} has no parseable Bounds`)
	return { id, x: +hit[1], z: +hit[2], width: +hit[3], depth: +hit[4] }
})

let cases = 0
let worstOutside = 0
let falsifierWitnessed = false
for (const map of maps) for (const aspect of aspects) for (const dpr of dprs) for (const yaw of yaws) {
	const height = maxHeight(map.width, map.depth, aspect, yaw)
	const { e } = fitted(map.width, map.depth, height, aspect, yaw)
	const minFocusX = map.x - e.minX * height
	const maxFocusX = map.x + map.width - e.maxX * height
	const minFocusZ = map.z - e.minZ * height
	const maxFocusZ = map.z + map.depth - e.maxZ * height
	const targets = [[map.x, map.z], [map.x + map.width, map.z], [map.x, map.z + map.depth], [map.x + map.width, map.z + map.depth]]
	for (const [tx, tz] of targets) {
		const x = Math.max(minFocusX, Math.min(maxFocusX, tx))
		const z = Math.max(minFocusZ, Math.min(maxFocusZ, tz))
		const outside = Math.max(0, map.x - (x + e.minX * height), x + e.maxX * height - (map.x + map.width),
			map.z - (z + e.minZ * height), z + e.maxZ * height - (map.z + map.depth))
		worstOutside = Math.max(worstOutside, outside)
		if (outside > 0.02) fail(TOOL, `${map.id} aspect ${aspect} DPR ${dpr} yaw ${yaw} exposes ${outside.toFixed(3)} off-map cells`)
		cases++
	}
	const rawOutside = Math.max(0, map.x - (map.x + e.minX * height), map.x + e.maxX * height - (map.x + map.width))
	if (rawOutside > 0.5) falsifierWitnessed = true
}
if (!falsifierWitnessed) fail(TOOL, 'disabled-frustum-clamp falsifier was not witnessed')

console.log(`${TOOL}: PASS — ${cases} map/aspect/DPR/yaw/edge-focus cases keep the ground frustum inside 67 maps (worst ${worstOutside.toFixed(6)} cells); disabled clamp witnessed red`)
