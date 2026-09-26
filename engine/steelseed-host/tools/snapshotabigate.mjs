#!/usr/bin/env node

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootRuntime, configFor, snapshotHeader, waitForSnapshot } from './runtime-fixture.mjs'
import { fail } from './gate-lib.mjs'

const TOOL = 'snapshotabigate'
const MAGIC = 0x504e5353
const VERSION = 2
const SECTION = { world: 0, terrain: 1, actors: 3, lifecycle: 4, projectiles: 5, shroud: 6, events: 7, players: 8, production: 9, frozenActors: 10, resources: 11, deployments: 12 }
const align4 = value => (value + 3) & ~3

const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps.find(candidate => candidate.title === 'Doubles') ?? catalog.maps[0]
const started = runtime.bridge.startSkirmish(configFor(catalog, map, { randomSeed: 104729 }))
if (started.status !== 'loading') fail(TOOL, `start returned ${started.status}/${started.code}`)

let terrainFrame = null
const result = await waitForSnapshot(runtime, {
	minimumTick: 5,
	onSnapshot(header, bytes) {
		if (terrainFrame == null && (header.flags & 1) !== 0)
			terrainFrame = bytes.slice(0, header.length)
	},
})
const liveFrame = result.bytes.slice(0, result.header.length)
if (terrainFrame == null) fail(TOOL, 'no terrain-static frame was emitted at map start')

const live = validateFrame(liveFrame, false)
const initial = validateFrame(terrainFrame, true)
const SnapshotDecoder = await loadWebDecoder()
const decodedInitial = new SnapshotDecoder().decode(terrainFrame)
const decoded = new SnapshotDecoder().decode(liveFrame)

if (!decoded.valid || decoded.tick < 5 || decoded.world == null || decoded.actors == null)
	fail(TOOL, 'web decoder did not expose the live ABI v2 world/actor data')
if (decoded.world.environmentPresent || decoded.world.environment !== null)
	fail(TOOL, 'missing simulation environment was fabricated by the web decoder')
if (decoded.projectiles === null)
	fail(TOOL, 'live producer published no projectile section — the ABI contract requires section 5 every tick')
if (decoded.players.length !== live.playerCount || decoded.production.length !== live.productionCount)
	fail(TOOL, 'web decoder player/production counts differ from the independent layout parser')
if (decodedInitial.terrainStatic == null || decodedInitial.terrainStatic.w !== initial.width ||
	decodedInitial.terrainStatic.h !== initial.height)
	fail(TOOL, 'web decoder did not decode the one-shot authoritative terrain section')
if (decoded.shroud.reduce((sum, run) => sum + run.runLength, 0) !== live.cellCount)
	fail(TOOL, 'web decoder shroud RLE does not cover the complete map bounds')
for (let index = 0; index < decoded.actors.count; index++) {
	const owner = decoded.actors.owner[index]
	if (owner !== 255 && owner >= decoded.players.length)
		fail(TOOL, `web decoder actor ${index} owner ${owner} is outside the player table`)
}

// Witnessed red: a stale presentation build must reject this producer immediately.
const stale = liveFrame.slice()
new DataView(stale.buffer, stale.byteOffset, stale.byteLength).setUint16(4, VERSION - 1, true)
let rejected = false
try { new SnapshotDecoder().decode(stale) } catch (error) { rejected = /version 1/.test(String(error)) }
if (!rejected) fail(TOOL, 'ABI-version falsifier was accepted by the web decoder')

console.log(`${TOOL}: PASS — live WASM ABI v${VERSION}, tick ${decoded.tick}, ${live.sectionCount} sections, ` +
	`${decoded.actors.count} visible actors/${decoded.players.length} players/${decoded.production.length} production queues, ` +
	`${live.shroudRuns} real shroud runs over ${live.cellCount} cells; TypeScript decoder roundtrip; stale-version falsifier witnessed red`)
process.exit(0)

function validateFrame(bytes, expectTerrain) {
	const header = snapshotHeader(bytes)
	if (header.magic !== MAGIC || header.version !== VERSION)
		fail(TOOL, `producer header is 0x${header.magic.toString(16)}/v${header.version}`)
	const sectionCount = header.view.getUint16(6, true)
	if (sectionCount !== header.sections.size) fail(TOOL, 'duplicate section ids in ABI table')
const required = [SECTION.world, SECTION.actors, SECTION.lifecycle, SECTION.projectiles, SECTION.shroud, SECTION.events, SECTION.players, SECTION.production, SECTION.frozenActors, SECTION.resources, SECTION.deployments]
for (const id of required) if (!header.sections.has(id)) fail(TOOL, `required section ${id} is absent`)
	if (header.sections.has(SECTION.terrain) !== expectTerrain || Boolean(header.flags & 1) !== expectTerrain)
		fail(TOOL, `terrain-static presence/flag mismatch (expected ${expectTerrain})`)

	const ranges = [...header.sections.entries()].map(([id, section]) => ({ id, ...section }))
		.sort((a, b) => a.offset - b.offset)
	let end = 32 + sectionCount * 12
	for (const range of ranges) {
		if ((range.offset & 3) !== 0 || (range.byteLength & 3) !== 0)
			fail(TOOL, `section ${range.id} is not four-byte aligned`)
		if (range.offset < end) fail(TOOL, `section ${range.id} overlaps the ABI table or prior section`)
		end = range.offset + range.byteLength
	}

	const world = header.sections.get(SECTION.world)
	if (world.byteLength !== 28) fail(TOOL, `world length ${world.byteLength} fabricates or truncates optional environment data`)
	const view = header.view
	const left = view.getInt32(world.offset, true)
	const top = view.getInt32(world.offset + 4, true)
	const right = view.getInt32(world.offset + 8, true)
	const bottom = view.getInt32(world.offset + 12, true)
	const width = right - left
	const height = bottom - top
	const cellCount = width * height
	if (width <= 0 || height <= 0 || view.getUint32(world.offset + 16, true) !== 1024)
		fail(TOOL, `invalid world bounds/cell scale ${left},${top}..${right},${bottom}`)
	if (view.getUint32(world.offset + 24, true) !== 0) fail(TOOL, 'environment-present flag is non-zero without authoritative data')
	const resources = header.sections.get(SECTION.resources)
	if (view.getUint16(resources.offset, true) !== width || view.getUint16(resources.offset + 2, true) !== height ||
		resources.byteLength !== align4(8 + 3 * cellCount))
		fail(TOOL, 'resource section dimensions or plane lengths disagree with world bounds')

	if (expectTerrain) {
		const terrain = header.sections.get(SECTION.terrain)
		if (view.getUint32(terrain.offset, true) !== width || view.getUint32(terrain.offset + 4, true) !== height)
			fail(TOOL, 'terrain dimensions differ from world bounds')
		const expectedLength = 8 + 6 * align4(cellCount)
		if (terrain.byteLength !== expectedLength)
			fail(TOOL, `terrain length ${terrain.byteLength} != independent layout ${expectedLength}`)
	}

	const players = parsePlayers(view, header.sections.get(SECTION.players))
	const renderPlayer = view.getUint16(world.offset + 20, true)
	if (renderPlayer >= players.length || players.filter(player => (player.flags & 2) !== 0).length !== 1 ||
		(players[renderPlayer].flags & 2) === 0)
		fail(TOOL, 'world render-player index and authoritative player flags disagree')
	if (!players.some(player => (player.flags & 4) !== 0)) fail(TOOL, 'live skirmish has no OpenRA-owned bot player')
	if (new Set(players.map(player => player.rgba.join(','))).size < 2)
		fail(TOOL, 'authoritative player colors were equalized')

	const actors = header.sections.get(SECTION.actors)
	const actorCount = view.getUint32(actors.offset, true)
	const turretCount = view.getUint32(actors.offset + 4, true)
	const animOffset = actors.offset + 8 + actorCount * 20
	const productionProgressOffset = actors.offset + 8 + actorCount * 22
	const speedOffset = actors.offset + 8 + actorCount * 26
	for (let index = 0; index < actorCount; index++) {
		if (view.getUint16(animOffset + index * 2, true) !== 0xffff ||
			view.getUint16(productionProgressOffset + index * 2, true) !== 0xffff)
			fail(TOOL, `actor ${index} fabricated animation or actor-level production progress`)
	}

	const frozen = header.sections.get(SECTION.frozenActors)
	const frozenCount = view.getUint32(frozen.offset, true)
	let frozenCursor = align4(frozen.offset + 4 + frozenCount * 18)
	const frozenOwnerOffset = frozenCursor
	frozenCursor += frozenCount * 2
	if (align4(frozenCursor) - frozen.offset !== frozen.byteLength)
		fail(TOOL, `frozen actor section length ${frozen.byteLength} disagrees with ${frozenCount} records`)
	for (let index = 0; index < frozenCount; index++) {
		const owner = view.getUint8(frozenOwnerOffset + index)
		if (owner !== 255 && owner >= players.length) fail(TOOL, `frozen actor ${index} owner ${owner} is outside player table`)
	}
	if (expectTerrain && actorCount > 0 &&
		!Array.from({ length: actorCount }, (_, index) => view.getUint16(speedOffset + index * 2, true)).every(value => value === 0xffff))
		fail(TOOL, 'first actor sample fabricated speed without a preceding authoritative position')
	let actorCursor = align4(actors.offset + 8 + actorCount * 28)
	const ownerOffset = actorCursor
		// Nine per-actor U8 planes after the aligned fixed planes: owner, health, cargo passengers,
		// turret count, flags, surface, ammo, reserved ammo, veterancy (SnapshotEmitter.WriteActors).
		actorCursor = align4(actorCursor + actorCount * 9)
		// The completion branch added the display-type plane; air/naval appends falling-husk
		// parent ids after it. Both presentation arrays are part of the same actors section.
		actorCursor = align4(actorCursor + actorCount * 2)
		actorCursor = align4(actorCursor + turretCount * 2) + actorCount * 4 // falling-husk parent ids
	if (align4(actorCursor) - actors.offset !== actors.byteLength)
		fail(TOOL, `actor section length ${actors.byteLength} disagrees with ${actorCount} actors/${turretCount} turrets`)
	for (let index = 0; index < actorCount; index++) {
		const owner = view.getUint8(ownerOffset + index)
		if (owner !== 255 && owner >= players.length) fail(TOOL, `actor ${index} owner ${owner} is outside player table`)
	}

	const lifecycle = header.sections.get(SECTION.lifecycle)
	const lifecycleCount = view.getUint32(lifecycle.offset, true)
	if (lifecycle.byteLength !== align4(4 + lifecycleCount * 8)) fail(TOOL, 'lifecycle record layout mismatch')
	for (let index = 0; index < lifecycleCount; index++) {
		const owner = view.getUint8(lifecycle.offset + 4 + index * 8 + 7)
		if (owner !== 255 && owner >= players.length) fail(TOOL, `lifecycle owner ${owner} is outside player table`)
	}

	const events = header.sections.get(SECTION.events)
	let eventCursor = events.offset + 4
	for (let index = 0; index < view.getUint32(events.offset, true); index++) {
		if (eventCursor + 4 > events.offset + events.byteLength) fail(TOOL, `event ${index} header overruns section`)
		const payloadLength = view.getUint16(eventCursor + 2, true)
		eventCursor = align4(eventCursor + 4 + payloadLength)
		if (eventCursor > events.offset + events.byteLength) fail(TOOL, `event ${index} payload overruns section`)
	}
	if (eventCursor !== events.offset + events.byteLength) fail(TOOL, 'event section has unclaimed bytes')

	const shroud = header.sections.get(SECTION.shroud)
	const shroudRuns = view.getUint32(shroud.offset, true)
	if (shroud.byteLength !== align4(4 + shroudRuns * 8) || shroudRuns === 0) fail(TOOL, 'missing or malformed shroud RLE')
	let covered = 0
	const stateCounts = [0, 0, 0]
	for (let index = 0; index < shroudRuns; index++) {
		const offset = shroud.offset + 4 + index * 8
		const start = view.getUint32(offset, true)
		const length = view.getUint16(offset + 4, true)
		const state = view.getUint8(offset + 6)
		if (start !== covered || length === 0 || state > 2) fail(TOOL, `invalid shroud run ${index}`)
		covered += length
		stateCounts[state] += length
	}
	if (covered !== cellCount || (!expectTerrain && (stateCounts[0] === 0 || stateCounts[2] === 0)))
		fail(TOOL, `shroud covers ${covered}/${cellCount}; states ${stateCounts.join('/')}`)

	const productionCount = parseProduction(view, header.sections.get(SECTION.production), players.length)
	return { sectionCount, width, height, cellCount, playerCount: players.length, productionCount, shroudRuns }
}

function parsePlayers(view, section) {
	const count = view.getUint32(section.offset, true)
	const end = section.offset + section.byteLength
	const players = []
	let cursor = section.offset + 4
	for (let index = 0; index < count; index++) {
		if (cursor + 36 > end) fail(TOOL, `player ${index} header overruns section`)
		const queueCount = view.getUint16(cursor + 30, true)
		players.push({
			flags: view.getUint8(cursor + 21),
			rgba: [view.getUint8(cursor + 22), view.getUint8(cursor + 23), view.getUint8(cursor + 24), view.getUint8(cursor + 25)],
			score: view.getUint32(cursor + 26, true),
		})
		cursor += 36 + queueCount * 8
		if (cursor > end) fail(TOOL, `player ${index} queues overrun section`)
	}
	if (align4(cursor) !== end) fail(TOOL, `player layout consumes ${align4(cursor) - section.offset}/${section.byteLength} bytes`)
	if (players.some(player => player.score !== 0xffffffff)) fail(TOOL, 'player section fabricated a synchronized score')
	return players
}

function parseProduction(view, section, playerCount) {
	const count = view.getUint32(section.offset, true)
	const end = section.offset + section.byteLength
	let cursor = section.offset + 4
	for (let index = 0; index < count; index++) {
		if (cursor + 12 > end) fail(TOOL, `production queue ${index} header overruns section`)
		const player = view.getUint8(cursor)
		const itemCount = view.getUint16(cursor + 10, true)
		if (player >= playerCount) fail(TOOL, `production queue ${index} player ${player} is outside player table`)
		cursor += 12 + itemCount * 12
		if (cursor > end) fail(TOOL, `production queue ${index} items overrun section`)
	}
	if (align4(cursor) !== end) fail(TOOL, `production layout consumes ${align4(cursor) - section.offset}/${section.byteLength} bytes`)
	return count
}

async function loadWebDecoder() {
	const gameRoot = resolve(import.meta.dirname, '../../..')
	const esbuild = await import(pathToFileURL(resolve(gameRoot, 'web/node_modules/esbuild/lib/main.js')).href)
	const directory = mkdtempSync(join(tmpdir(), 'steelseed-snapshotabi-'))
	const entry = join(directory, 'entry.ts')
	const bundle = join(directory, 'decoder.mjs')
	writeFileSync(entry, `export { SnapshotDecoder } from ${JSON.stringify(resolve(gameRoot, 'web/src/core/snapshot.ts'))}\n`)
	await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent' })
	return (await import(`${pathToFileURL(bundle).href}?gate=${Date.now()}`)).SnapshotDecoder
}
