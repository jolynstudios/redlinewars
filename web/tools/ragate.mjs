#!/usr/bin/env node

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const TOOL = 'ragate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const falsifier = process.argv.find(arg => arg.startsWith('--falsify='))?.slice(10) ?? null
if (falsifier != null && !['facing', 'color', 'frustum', 'pan'].includes(falsifier))
	throw new Error(`${TOOL}: unknown falsifier '${falsifier}'`)

const tmp = mkdtempSync(join(tmpdir(), 'steelseed-ragate-'))
const entry = join(tmp, 'entry.ts')
const bundle = join(tmp, 'bundle.mjs')
writeFileSync(entry, `
	export { CameraSystem } from '${WEB}/src/camera/index.ts'
	export { placeActor } from '${WEB}/src/core/place.ts'
	export { buildDevSnapshotAt } from '${WEB}/src/core/devsnapshot.ts'
	export { SnapshotDecoder, wangleToRadians } from '${WEB}/src/core/snapshot.ts'
`)
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent' })
const { CameraSystem, placeActor, buildDevSnapshotAt, SnapshotDecoder, wangleToRadians } = await import(bundle)
const failures = []

const directions = [
	[0, 0, -1], [128, -Math.SQRT1_2, -Math.SQRT1_2], [256, -1, 0], [384, -Math.SQRT1_2, Math.SQRT1_2],
	[512, 0, 1], [640, Math.SQRT1_2, Math.SQRT1_2], [768, 1, 0], [896, Math.SQRT1_2, -Math.SQRT1_2],
]
for (const [wangle, expectedX, expectedZ] of directions) {
	const matrix = new Float32Array(16)
	const yaw = falsifier === 'facing' ? wangle / 1024 * Math.PI * 2 : wangleToRadians(wangle)
	placeActor(matrix, 0, 0, 0, yaw, 1, 1, false, 0, () => 0)
	if (Math.abs(matrix[0] - expectedX) > 1e-5 || Math.abs(matrix[2] - expectedZ) > 1e-5)
		failures.push(`facing ${wangle}: forward (${matrix[0].toFixed(4)},${matrix[2].toFixed(4)}) != (${expectedX.toFixed(4)},${expectedZ.toFixed(4)})`)
}

const decoded = new SnapshotDecoder().decode(buildDevSnapshotAt(23, { seed: 'ra-color-gate' }))
if (decoded.players.length < 2) failures.push('color fixture has fewer than two players')
else {
	const rgba = decoded.players.map(player => [player.red, player.green, player.blue, player.alpha].join(','))
	if (falsifier === 'color' || new Set(rgba).size !== rgba.length)
		failures.push(`authoritative player colors collapsed: ${rgba.join(' / ')}`)
	for (let i = 0; i < (decoded.actors?.count ?? 0); i++)
		if (decoded.actors.owner[i] >= decoded.players.length)
			failures.push(`actor ${i} owner ${decoded.actors.owner[i]} is not a player-table index`)
}

for (const [width, height] of [[640, 480], [1920, 1080], [2560, 1080], [900, 1600]]) {
	for (const [mapWidth, mapHeight] of [[64, 64], [128, 64], [192, 128]]) {
		for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4]) {
			const camera = new CameraSystem()
			const input = { pointer: { x: width / 2, y: height / 2, dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, inside: false }, isDown: () => false, wasPressed: () => false }
			const ctx = { canvas: { width, height, clientWidth: width, clientHeight: height }, input, issueOrder: () => {}, peek: () => null }
			await camera.init(ctx)
			camera.resize(width, height, ctx)
			camera.yaw = yaw
			camera.yawGoal = yaw
			camera.onSnapshot({
				world: { renderPlayer: 0, boundsLeft: 0, boundsTop: 0, boundsRight: mapWidth, boundsBottom: mapHeight },
				actors: { count: 1, owner: new Uint8Array([0]), posX: new Int32Array([10 * 1024]), posY: new Int32Array([10 * 1024]) },
			}, null, ctx)
			camera.update(1 / 60, ctx)
			// The camera's contract changed in 6976ff4: the map-fit pitch search that kept
			// the whole ground frustum inside the map was replaced by a fixed pitch curve
			// plus a user tilt, and the guarantee moved from "the footprint covers the
			// map" to "the focus pivot can never leave the map". Assert the current
			// contract; asserting the old one asserted removed behaviour.
			const tx = camera.target[0]
			const tz = camera.target[2]
			if (tx < -1e-3 || tx > mapWidth + 1e-3 || tz < -1e-3 || tz > mapHeight + 1e-3)
				failures.push(`focus ${width}x${height} map ${mapWidth}x${mapHeight} yaw ${yaw.toFixed(2)} escapes [${tx.toFixed(2)},${tz.toFixed(2)}]`)
		}
	}
}

// Screen-space pan must stay screen-aligned after the opening camera rotates toward an
// edge spawn. This is the user-facing contract: right-edge scroll moves right on screen,
// top-edge scroll moves up, independent of world north or yaw.
for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4]) {
	for (const [source, key, pointerX, pointerY, pointerInside, screenX, screenY] of [
		['key-right', 'KeyD', 320, 240, false, 1, 0],
		['key-up', 'KeyW', 320, 240, false, 0, -1],
		['edge-right', null, 639, 240, true, 1, 0],
		['edge-up', null, 320, 0, true, 0, -1],
	]) {
		const camera = new CameraSystem()
		const input = {
			pointer: {
				x: pointerX, y: pointerY, dx: 0, dy: 0, wheel: 0,
				buttons: 0, pressed: 0, inside: pointerInside, edgeReady: pointerInside,
			},
			isDown: candidate => candidate === key,
			wasPressed: () => false,
		}
		const ctx = { canvas: { width: 640, height: 480, clientWidth: 640, clientHeight: 480 }, input, issueOrder: () => {}, peek: () => null }
		await camera.init(ctx)
		camera.yaw = yaw
		camera.yawGoal = yaw
		const beforeX = camera.targetGoal[0]
		const beforeZ = camera.targetGoal[2]
		camera.readInput(1 / 60, ctx)
		const dx = camera.targetGoal[0] - beforeX
		const dz = camera.targetGoal[2] - beforeZ
		const measured = Math.hypot(dx, dz) || 1
		const checkYaw = falsifier === 'pan' ? -yaw : yaw
		const rightX = Math.cos(checkYaw), rightZ = -Math.sin(checkYaw)
		const downX = Math.sin(checkYaw), downZ = Math.cos(checkYaw)
		const expectedX = screenX * rightX + screenY * downX
		const expectedZ = screenX * rightZ + screenY * downZ
		const alignment = dx / measured * expectedX + dz / measured * expectedZ
		if (alignment < .99999)
			failures.push(`pan yaw ${yaw.toFixed(2)} ${source} alignment ${alignment.toFixed(6)} is not screen-aligned`)
	}
}

// A stationary cursor exposed by the setup overlay disappearing is not a deliberate
// edge-scroll gesture. This is the exact black-start falsifier: without edgeReady the
// spawn camera must remain untouched even if the stale coordinate lies on a corner.
{
	const camera = new CameraSystem()
	const input = {
		pointer: { x: 0, y: 0, dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, inside: true, edgeReady: false },
		isDown: () => false,
		wasPressed: () => false,
	}
	const ctx = { canvas: { width: 640, height: 480, clientWidth: 640, clientHeight: 480 }, input, issueOrder: () => {}, peek: () => null }
	await camera.init(ctx)
	const beforeX = camera.targetGoal[0]
	const beforeZ = camera.targetGoal[2]
	camera.readInput(1, ctx)
	if (camera.targetGoal[0] !== beforeX || camera.targetGoal[2] !== beforeZ)
		failures.push('stationary setup cursor armed edge-scroll and moved the spawn camera')
}

if (failures.length > 0) {
	for (const failure of failures.slice(0, 20)) console.error(`${TOOL}: ${failure}`)
	console.error(`${TOOL}: FAIL — ${failures.length} RA presentation contract violation(s)`)
	process.exit(1)
}
console.log(`${TOOL}: facinggate PASS — cardinal and diagonal OpenRA facings share one hull/turret conversion`)
console.log(`${TOOL}: colorgate PASS — authoritative RGBA players remain distinct and actor owners index that table`)
console.log(`${TOOL}: mapfillgate PASS — 48 aspect/map/yaw cases keep the camera focus inside map bounds`)
