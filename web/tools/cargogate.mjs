#!/usr/bin/env node
// STEELSEED — tools/cargogate
// Passenger flow through OpenRA's own orders on the real WASM simulation: a rifleman
// right-clicked on an own APC must resolve to EnterTransport through the same contextual
// path the UI uses, the snapshot's passenger count must rise, and Unload — the order the
// HUD deploy button sends for a Cargo actor — must put the passenger back on the ground.
// Plain ground must still resolve to Move, and a transform-less transport must not accept
// DeployTransform, which is what the deploy button used to send for every actor.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transform } from 'esbuild'
import { bootRuntime, configFor, waitForSnapshot } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const TOOL = 'cargogate'
const source = readFileSync(resolve(import.meta.dirname, '../src/core/snapshot.ts'), 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
const { SnapshotDecoder } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`)
const decoder = new SnapshotDecoder()
const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps.find(candidate => candidate.title === 'Doubles')
if (!map) throw new Error(`${TOOL}: pinned Doubles map is unavailable`)
// Soviet "light" support units ship an APC and riflemen, so no production is needed.
const config = configFor(catalog, map, { randomSeed: 104729, withBot: false })
config.gameSpeed = catalog.gameSpeeds.find(speed => speed.id === 'fastest')?.id ?? config.gameSpeed
for (const [key, value] of [['startingunits', 'light'], ['fog', 'False'], ['explored', 'True'], ['crates', 'False']]) {
	const option = map.options.find(candidate => candidate.id.toLowerCase() === key)
	const choice = option?.values.find(candidate => candidate.id.toLowerCase() === value.toLowerCase())
	if (!option || option.isLocked || !choice) throw new Error(`${TOOL}: unavailable option ${key}=${value}`)
	config.options[option.id] = choice.id
}
const factions = map.factions.map(f => f.id)
const soviet = ['russia', 'ukraine', 'soviet'].find(id => factions.includes(id))
if (!soviet) throw new Error(`${TOOL}: no Soviet faction on ${map.title}: ${factions.join(',')}`)
config.local.faction = soviet
const localSlot = config.slots.find(slot => slot.slot === config.local.slot)
if (localSlot) localSlot.faction = soviet
const started = runtime.bridge.startSkirmish(config)
if (started.status !== 'loading') throw new Error(`${TOOL}: start failed ${JSON.stringify(started)}`)

let snap = null
let names = []
const deadline = Date.now() + 240000
await until('initial world', () => snap?.tick >= 5 && owned('apc').length === 1 && owned('e1').length >= 1)

const apc = owned('apc')[0]
const rifleman = owned('e1')[0]
const passengersBefore = cargoOf(apc.id)
if (passengersBefore !== 0) throw new Error(`${TOOL}: APC starts with ${passengersBefore} passengers`)

// 1. Contextual right-click on the own transport: OpenRA must choose EnterTransport.
const enter = contextual(rifleman.id, apc.id, null)
if (!/^ok:.*\(EnterTransport\)/.test(enter)) throw new Error(`${TOOL}: rifleman on APC did not resolve to EnterTransport: ${enter}`)
await until('passenger boarded', () => cargoOf(apc.id) === 1 && owned('e1').every(e => e.id !== rifleman.id))
const boardedTick = snap.tick

// 2. Plain ground still moves; the transport itself must not take the MCV's transform order.
const move = contextual(apc.id, 0, { x: Math.floor(apc.x) + 3, y: Math.floor(apc.y) })
if (!/^ok:.*\(Move\)/.test(move)) throw new Error(`${TOOL}: APC on plain ground did not resolve to Move: ${move}`)
const transformAttempt = runtime.bridge.issueOrder({ orderString: 'DeployTransform', subjectIds: Uint32Array.of(apc.id) })
await until('transform attempt settled', () => snap.tick >= boardedTick + 10)
if (owned('apc').length !== 1 || cargoOf(apc.id) !== 1)
	throw new Error(`${TOOL}: DeployTransform changed a Cargo actor (${transformAttempt})`)

// 3. Unload — what the HUD deploy button now sends for a Cargo actor — returns the rifleman.
const unload = runtime.bridge.issueOrder({ orderString: 'Unload', subjectIds: Uint32Array.of(apc.id) })
if (!unload.startsWith('ok:')) throw new Error(`${TOOL}: Unload rejected: ${unload}`)
await until('passenger unloaded', () => cargoOf(apc.id) === 0 && owned('e1').some(e => e.id === rifleman.id))

console.log(`${TOOL}: PASS — rifleman→APC resolved "${enter.replace(/^ok: /, '')}", passengers 0→1 by tick ${boardedTick}, ` +
	`plain ground → Move, DeployTransform inert on a Cargo actor, Unload → passengers 0 and rifleman back in world by tick ${snap.tick}`)
process.exit(0)

async function until(label, predicate) {
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`${TOOL}: timed out during ${label}, tick=${snap?.tick}`)
		await waitForSnapshot(runtime, {
			minimumTick: (snap?.tick ?? 0) + 1,
			timeoutMs: 30000,
			onSnapshot(_header, bytes) {
				snap = decoder.decode(bytes)
				names = runtime.bridge.snapshotTypeTable().split('\n')
			},
		})
	}
}

function owned(type) {
	const actors = snap.actors
	const result = []
	for (let i = 0; i < actors.count; i++)
		if (actors.owner[i] === snap.world.renderPlayer && names[actors.typeId[i]] === type)
			result.push({ id: actors.id[i], x: actors.posX[i] / 1024, y: actors.posY[i] / 1024 })
	return result
}

function cargoOf(actorId) {
	const actors = snap.actors
	for (let i = 0; i < actors.count; i++) if (actors.id[i] === actorId) return actors.cargo[i]
	return -1
}

function contextual(subjectId, targetActorId, cell) {
	return runtime.bridge.issueContextOrder({
		subjectIds: Uint32Array.of(subjectId),
		subjectCount: 1,
		targetActorId,
		targetCellX: cell ? cell.x : -1,
		targetCellY: cell ? cell.y : -1,
		targetFrozen: false,
		modifiers: 0,
	})
}
