#!/usr/bin/env node

import { bootRuntime, configFor, renderPlayerIndex, snapshotHeader, waitForSnapshot } from './runtime-fixture.mjs'
import { fail } from './gate-lib.mjs'

const TOOL = 'contextcollisiongate'
const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps.find(candidate => candidate.title === 'Marigold Town') ?? catalog.maps[0]
const config = configFor(catalog, map, { randomSeed: 104729, withBot: false })
config.options.startingunits = 'light'
config.options.explored = 'True'
config.options.fog = 'False'
config.local.faction = 'england'
config.slots.find(slot => slot.slot === config.local.slot).faction = 'england'
const started = runtime.bridge.startSkirmish(config)
if (started.status !== 'loading') fail(TOOL, `start returned ${started.status}/${started.code}`)

let terrainBytes = null
const initialResult = await waitForSnapshot(runtime, {
	minimumTick: 5,
	onSnapshot(header, bytes) {
		if (terrainBytes == null && header.sections.has(1)) terrainBytes = bytes.slice(0, header.length)
	},
})
if (terrainBytes == null) fail(TOOL, 'initial terrain-static snapshot was not captured')
const terrain = parseTerrain(snapshotHeader(terrainBytes))
const names = runtime.bridge.snapshotTypeTable().split('\n')
const local = renderPlayerIndex(initialResult.header)
let actors = parseActors(initialResult.header)
const support = findOwnedType(actors, names, local, ['jeep', '1tnk'])
const mcv = findOwnedType(actors, names, local, ['mcv'])
if (support < 0 || mcv < 0) fail(TOOL, `Light Support did not create an Allied mobile unit and MCV; local actors: ${
	actors.type.filter((_, index) => actors.owner[index] === local).map(type => names[type]).join(',')}`)

const supportId = actors.id[support]
const mcvId = actors.id[mcv]
const startX = actors.x[support] / 1024
const startY = actors.y[support] / 1024
const startCell = { x: Math.floor(startX), y: Math.floor(startY) }
const landTarget = nearestCell(terrain, startCell, index => (terrain.passability[index] & 2) !== 0, 4)
if (!landTarget) fail(TOOL, 'no nearby wheeled-passable land witness cell')
const moveResult = issueContext(supportId, landTarget)
if (!String(moveResult).startsWith('ok:')) fail(TOOL, `OpenRA contextual move was rejected: ${moveResult}`)
let result = await waitForSnapshot(runtime, { minimumTick: initialResult.header.tick + 120 })
actors = parseActors(result.header)
let supportIndex = actors.id.indexOf(supportId)
if (supportIndex < 0) fail(TOOL, 'support unit disappeared during movement witness')
const moved = Math.hypot(actors.x[supportIndex] / 1024 - startX, actors.y[supportIndex] / 1024 - startY)
if (moved < 0.5) fail(TOOL, `contextual OpenRA move changed position by only ${moved.toFixed(2)} cells`)

const waterTarget = nearestCell(terrain,
	{ x: Math.floor(actors.x[supportIndex] / 1024), y: Math.floor(actors.y[supportIndex] / 1024) },
	index => terrain.surface[index] === 8 && (terrain.passability[index] & 2) === 0,
	0)
if (!waterTarget) fail(TOOL, 'witness map has no water cell forbidden to wheeled locomotion')
issueContext(supportId, waterTarget)
result = await waitForSnapshot(runtime, { minimumTick: result.header.tick + 180 })
actors = parseActors(result.header)
supportIndex = actors.id.indexOf(supportId)
const afterWater = terrain.index(Math.floor(actors.x[supportIndex] / 1024), Math.floor(actors.y[supportIndex] / 1024))
if (afterWater < 0 || terrain.surface[afterWater] === 8 || (terrain.passability[afterWater] & 2) === 0)
	fail(TOOL, 'wheeled unit entered OpenRA-forbidden water')

const currentMcv = actors.id.indexOf(mcvId)
if (currentMcv < 0) fail(TOOL, 'MCV disappeared before collision witness')
const deploy = runtime.bridge.issueOrder({
	orderString: 'DeployTransform', subjectIds: Uint32Array.of(mcvId),
	targetActorId: 0, targetCellX: -1, targetCellY: -1, queued: false, targetString: '', extraData: 0,
})
if (!String(deploy).startsWith('ok: issued 1/1')) fail(TOOL, `MCV deploy was rejected: ${deploy}`)
result = await waitForSnapshot(runtime, { minimumTick: result.header.tick + 60 })
actors = parseActors(result.header)
let building = findOwnedType(actors, runtime.bridge.snapshotTypeTable().split('\n'), local, ['fact'])
if (building < 0) fail(TOOL, 'MCV did not create construction-yard occupancy')
const buildingId = actors.id[building]
issueContext(supportId, { x: Math.floor(actors.x[building] / 1024), y: Math.floor(actors.y[building] / 1024) })
result = await waitForSnapshot(runtime, { minimumTick: result.header.tick + 300, timeoutMs: 30000 })
actors = parseActors(result.header)
supportIndex = actors.id.indexOf(supportId)
building = actors.id.indexOf(buildingId)
if (supportIndex < 0 || building < 0) fail(TOOL, 'collision witness actor disappeared')
const separation = Math.hypot(actors.x[supportIndex] / 1024 - actors.x[building] / 1024,
	actors.y[supportIndex] / 1024 - actors.y[building] / 1024)
if (separation < 1.25) fail(TOOL, `mobile actor overlapped construction-yard occupancy (${separation.toFixed(2)} cells)`)

console.log(`${TOOL}: PASS — browser context -> OpenRA targeters moved ${moved.toFixed(2)} cells; wheeled locomotor ` +
	`refused water; ActorMap/pathfinder stopped the unit ${separation.toFixed(2)} cells from the construction yard`)

function issueContext(actorId, cell) {
	return runtime.bridge.issueContextOrder({
		subjectIds: Uint32Array.of(actorId), targetActorId: 0,
		targetCellX: cell.x, targetCellY: cell.y, targetFrozen: false, modifiers: 0,
	})
}

function parseActors(header) {
	const section = header.sections.get(3)
	const count = header.view.getUint32(section.offset, true)
	let cursor = section.offset + 8
	const id = [], x = [], y = []
	for (let i = 0; i < count; i++) id.push(header.view.getUint32(cursor + i * 4, true)); cursor += count * 4
	for (let i = 0; i < count; i++) x.push(header.view.getInt32(cursor + i * 4, true)); cursor += count * 4
	for (let i = 0; i < count; i++) y.push(header.view.getInt32(cursor + i * 4, true)); cursor += count * 8
	const type = []
	for (let i = 0; i < count; i++) type.push(header.view.getUint16(cursor + i * 2, true)); cursor += count * 12
	cursor = (cursor + 3) & ~3
	const owner = []
	for (let i = 0; i < count; i++) owner.push(header.view.getUint8(cursor + i))
	return { count, id, x, y, type, owner }
}

function findOwnedType(actors, names, owner, wanted) {
	for (let i = 0; i < actors.count; i++)
		if (actors.owner[i] === owner && wanted.includes(names[actors.type[i]])) return i
	return -1
}

function parseTerrain(header) {
	const world = header.sections.get(0), section = header.sections.get(1), view = header.view
	const left = view.getInt32(world.offset, true), top = view.getInt32(world.offset + 4, true)
	const w = view.getUint32(section.offset, true), h = view.getUint32(section.offset + 4, true)
	const stride = (w * h + 3) & ~3
	const passability = new Uint8Array(view.buffer, view.byteOffset + section.offset + 8 + stride * 3, w * h)
	const surface = new Uint8Array(view.buffer, view.byteOffset + section.offset + 8 + stride * 5, w * h)
	return {
		left, top, w, h, passability, surface,
		index(x, y) { return x < left || y < top || x >= left + w || y >= top + h ? -1 : (y - top) * w + x - left },
	}
}

function nearestCell(terrain, origin, accept, minimumDistance) {
	let best = null, bestDistance = Infinity
	for (let y = terrain.top; y < terrain.top + terrain.h; y++) for (let x = terrain.left; x < terrain.left + terrain.w; x++) {
		const distance = Math.hypot(x - origin.x, y - origin.y)
		if (distance < minimumDistance || distance >= bestDistance || !accept(terrain.index(x, y))) continue
		best = { x, y }; bestDistance = distance
	}
	return best
}
