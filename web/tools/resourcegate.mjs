#!/usr/bin/env node
// Section 11 decoder bounds/cache controls + actual OpenRA scouting/fog-memory witness.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transform } from 'esbuild'
import { bootRuntime, configFor, waitForSnapshot } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const TOOL = 'resourcegate'
const compiled = await transform(readFileSync(resolve(import.meta.dirname, '../src/core/snapshot.ts'), 'utf8'),
	{ loader: 'ts', format: 'esm', target: 'es2022' })
const { SnapshotDecoder } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`)

const bytes = fixture()
const decoder = new SnapshotDecoder()
const first = decoder.decode(bytes)
const densityView = first.resources.density
assert.deepEqual([...first.resources.type], [1, 2, 0, 1, 0, 0])
assert.deepEqual([...densityView], [3, 5, 0, 1, 0, 0])
new DataView(bytes.buffer).setUint32(88, 2, true)
bytes[98] = 2
assert.equal(decoder.decode(bytes).resources.density, densityView, 'same slot must reuse typed views')
assert.equal(densityView[0], 2)
assert.equal(first.resources.revision, 2)
for (const [label, mutate] of [
	['truncated header', v => v.setUint32(52, 4, true)],
	['short plane', v => v.setUint32(52, 24, true)],
	['wrong dimensions', v => v.setUint16(84, 4, true)],
	['zero dimensions', v => v.setUint16(84, 0, true)],
	['unaligned resource section', v => v.setUint32(48, 81, true)],
	['header overlap', v => v.setUint32(48, 32, true)],
]) {
	const invalid = fixture()
	mutate(new DataView(invalid.buffer))
	assert.throws(() => new SnapshotDecoder().decode(invalid), /resource/, label)
}
const legacy = fixture()
// Retag the resource entry to an id assigned on NEITHER side of the snapshot
// contract (13 is free; 12 became the real, strictly-validated deployments
// section, so this fixture may no longer borrow it).
new DataView(legacy.buffer).setUint16(44, 13, true)
assert.equal(new SnapshotDecoder().decode(legacy).resources, null, 'section 11 remains optional')

const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps.find(candidate => candidate.title === 'Doubles')
const config = configFor(catalog, map, { randomSeed: 104729, withBot: false })
config.gameSpeed = 'fastest'
for (const [id, value] of [['fog', 'true'], ['explored', 'false'], ['crates', 'false']]) {
	const option = map.options.find(candidate => candidate.id.toLowerCase() === id)
	config.options[option.id] = option.values.find(candidate => candidate.id.toLowerCase() === value).id
}
assert.equal(runtime.bridge.startSkirmish(config).status, 'loading')
const liveDecoder = new SnapshotDecoder()
let snap = null
let staticResources = null
let states = null
let lastSeen = null
let hiddenChecks = 0
let rememberedChecks = 0
let revisionChanges = 0
let lastRevision = -1
let firstOre = -1
let initiallyHidden = null
let exploredMemoryChecks = 0
let terrainMemory = null
const exploration = []
const deadline = Date.now() + 90000
await until('initial world', () => snap?.tick >= 5)
const actorNames = runtime.bridge.snapshotTypeTable().split('\n')
const actors = snap.actors
let mcv = -1
for (let i = 0; i < actors.count; i++)
	if (actors.owner[i] === snap.world.renderPlayer && actorNames[actors.typeId[i]] === 'mcv') mcv = i
assert.notEqual(mcv, -1)
const id = actors.id[mcv]
const origin = { x: actors.posX[mcv] / 1024, y: actors.posY[mcv] / 1024 }
initiallyHidden = states.map(state => state === 0 ? 1 : 0)
const initialTick = snap.tick
const candidates = [...staticResources.keys()].filter(index => staticResources[index] !== 0 && initiallyHidden[index])
candidates.sort((a, b) => distance(a, origin) - distance(b, origin))
assert.ok(candidates.length > 0, 'map needs resource cells')
const resource = cell(candidates[0])
move(resource.x, resource.y)
await until('visible ore', () => {
	for (let i = 0; i < snap.resources.type.length; i++)
		if (initiallyHidden[i] && states[i] === 2 && snap.resources.type[i] !== 0) { firstOre = i; return true }
	return false
})
const seenCell = cell(firstOre)
exploration.push({ tick: initialTick, state: 0 }, { tick: snap.tick, state: 2 })
const middleX = (snap.world.boundsLeft + snap.world.boundsRight) * .5
move(Math.max(snap.world.boundsLeft + 3, Math.min(snap.world.boundsRight - 4,
	seenCell.x + (seenCell.x < middleX ? 24 : -24))), seenCell.y)
await until('remembered ore under fog', () => states[firstOre] === 1 && snap.resources.type[firstOre] !== 0)
exploration.push({ tick: snap.tick, state: 1 })
assert.match(runtime.bridge.issueOrder({ orderString: 'Stop', subjectIds: Uint32Array.of(id) }), /^ok: issued 1\/1/)
const rememberedTick = snap.tick
await until('explored terrain stays revealed after scout leaves', () => snap.tick >= rememberedTick + 75)
assert.equal(states[firstOre], 1, 'explored land must remain revealed after the scout leaves')
exploration.push({ tick: snap.tick, state: 1 })
assert.ok(hiddenChecks > 0, 'unexplored cells must be tested')
assert.ok(rememberedChecks > 0, 'previously observed ore must be tested under fog')
assert.ok(revisionChanges > 0, 'scouting must change the resource revision')

// Restart the same map/seed with the same decoder and pinned buffers. Fog memory belongs
// to a world, so previously explored remote ore must not survive into the new match.
const previousTick = snap.tick
const firstMatchHidden = hiddenChecks
assert.equal(runtime.bridge.startSkirmish(config).status, 'loading')
snap = null
staticResources = null
states = null
lastSeen = null
terrainMemory = null
lastRevision = -1
await until('fresh world after restart', () => snap?.tick >= 5)
assert.ok(snap.tick < previousTick, 'restart must begin a fresh simulation timeline')
assert.ok(hiddenChecks > firstMatchHidden, 'restart must recheck unexplored cells')
console.log(`${TOOL}: PASS — six malformed sections rejected, stable view reuse, legacy absence; ` +
	`${hiddenChecks} unexplored cells concealed, ${rememberedChecks} remembered ore samples unchanged under fog; ` +
	`scout cell (${seenCell.x},${seenCell.y}) ${exploration.map(step => `${step.state}@${step.tick}`).join(' -> ')}; ` +
	`${exploredMemoryChecks} explored terrain samples never returned to unexplored; ` +
	`world restart resets knowledge (tick ${previousTick}->${snap.tick})`)
process.exit(0)

async function until(label, predicate) {
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`${TOOL}: timed out during ${label} at tick ${snap?.tick}`)
		await waitForSnapshot(runtime, { minimumTick: (snap?.tick ?? 0) + 1, timeoutMs: 15000,
			onSnapshot(_header, frame) {
				snap = liveDecoder.decode(frame)
				assert.ok(snap.resources, 'host must publish resource section')
				if (!staticResources && snap.terrainStatic) staticResources = snap.terrainStatic.resource.slice()
				const resources = snap.resources
				if (!states) {
					states = new Uint8Array(resources.w * resources.h)
					lastSeen = new Int32Array(states.length).fill(-1)
					terrainMemory = new Uint8Array(states.length)
				}
				for (const run of snap.shroud) states.fill(run.state, run.cellIndex, run.cellIndex + run.runLength)
				for (let i = 0; i < states.length; i++) {
					if (terrainMemory[i]) {
						assert.notEqual(states[i], 0, 'previously explored terrain became unexplored')
						exploredMemoryChecks++
					}
					if (states[i] !== 0) terrainMemory[i] = 1
					const packed = resources.type[i] | resources.density[i] << 8 | resources.maxDensity[i] << 16
					assert.ok(resources.density[i] <= resources.maxDensity[i], 'density exceeds authoritative maximum')
					if (states[i] === 0) { assert.equal(packed, 0, 'unexplored resource leaked'); hiddenChecks++ }
					else if (states[i] === 2) lastSeen[i] = packed
					else if (lastSeen[i] > 0) { assert.equal(packed, lastSeen[i], 'ore changed behind fog'); rememberedChecks++ }
				}
				if (lastRevision >= 0 && lastRevision !== resources.revision) revisionChanges++
				lastRevision = resources.revision
			},
		})
	}
}

function cell(index) {
	return { x: snap.world.boundsLeft + index % snap.resources.w, y: snap.world.boundsTop + Math.floor(index / snap.resources.w) }
}
function distance(index, point) { const c = cell(index); return (c.x - point.x) ** 2 + (c.y - point.y) ** 2 }
function move(x, y) {
	const result = runtime.bridge.issueOrder({ orderString: 'Move', subjectIds: Uint32Array.of(id), targetCellX: x, targetCellY: y })
	assert.match(result, /^ok: issued 1\/1/)
}
function fixture() {
	const result = new Uint8Array(112)
	const v = new DataView(result.buffer)
	v.setUint32(0, 0x504e5353, true); v.setUint16(4, 2, true); v.setUint16(6, 2, true); v.setUint32(8, 112, true)
	v.setUint16(32, 0, true); v.setUint32(36, 56, true); v.setUint32(40, 28, true)
	v.setUint16(44, 11, true); v.setUint32(48, 84, true); v.setUint32(52, 28, true)
	v.setInt32(56, 7, true); v.setInt32(60, 11, true); v.setInt32(64, 10, true); v.setInt32(68, 13, true)
	v.setUint32(72, 1024, true)
	v.setUint16(84, 3, true); v.setUint16(86, 2, true); v.setUint32(88, 1, true)
	result.set([1, 2, 0, 1, 0, 0, 3, 5, 0, 1, 0, 0, 12, 12, 0, 12, 0, 0], 92)
	return result
}
