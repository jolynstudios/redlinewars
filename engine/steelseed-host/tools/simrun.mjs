#!/usr/bin/env node

import { actorIdsOwnedBy, bootRuntime, configFor, renderPlayerIndex, shroudStats, waitForSnapshot } from './runtime-fixture.mjs'
import { resolve } from 'node:path'

const seed = Number(process.argv.find(value => value.startsWith('--seed='))?.slice(7) ?? 104729)
const targetTick = Number(process.argv.find(value => value.startsWith('--tick='))?.slice(7) ?? 80)
const bundleArg = process.argv.find(value => value.startsWith('--bundle='))
const runtime = await bootRuntime(bundleArg ? { bundleRoot: resolve(bundleArg.slice('--bundle='.length)) } : undefined)
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps.find(value => value.title === 'Doubles') ?? catalog.maps[0]
// Public determinism runs use only fixed, recorded browser orders. The exact upstream
// normal bot intentionally chooses orders from World.LocalRandom (wall-clock seeded),
// so bot behavior is exercised separately by aidynamicgate and is not mislabeled as
// a same-seed simulation input.
const config = configFor(catalog, map, { randomSeed: seed, withBot: false })
const started = runtime.bridge.startSkirmish(config)
if (started.status !== 'loading') throw new Error(`simrun: start failed ${JSON.stringify(started)}`)

const checkpoints = []
let orderIssued = false
let nextCheckpoint = 20
let latestShroud = null
const { header } = await waitForSnapshot(runtime, {
	minimumTick: targetTick,
	timeoutMs: Math.max(20000, targetTick * 100),
	onSnapshot(current) {
		latestShroud = shroudStats(current) ?? latestShroud
		if (!orderIssued && current.tick >= 10) {
			const owner = renderPlayerIndex(current)
			const ids = actorIdsOwnedBy(current, owner)
			if (ids.length > 0) {
				const world = current.sections.get(0)
				const view = current.view
				const left = view.getInt32(world.offset, true), top = view.getInt32(world.offset + 4, true)
				const right = view.getInt32(world.offset + 8, true), bottom = view.getInt32(world.offset + 12, true)
				runtime.bridge.issueOrder({
					orderString: 'Move', subjectIds: Uint32Array.of(ids[0]),
					targetCellX: Math.floor((left + right) / 2), targetCellY: Math.floor((top + bottom) / 2),
				})
				orderIssued = true
			}
		}
		if (current.tick >= nextCheckpoint) {
			checkpoints.push([current.tick, current.syncHash])
			nextCheckpoint += 20
		}
	},
})

const playerSection = header.sections.get(8)
const outcomePlayers = []
if (playerSection) {
	let cursor = playerSection.offset + 4
	const count = header.view.getUint32(playerSection.offset, true)
	for (let index = 0; index < count; index++) {
		const queueCount = header.view.getUint16(cursor + 30, true)
		outcomePlayers.push({
			clientIndex: header.view.getInt32(cursor + 12, true),
			flags: header.view.getUint8(cursor + 21),
		})
		cursor += 36 + queueCount * 8
	}
}
const outcome = { gameOver: (header.flags & (1 << 3)) !== 0, players: outcomePlayers }
console.log(`SIMRESULT ${JSON.stringify({ seed, targetTick, tick: header.tick, syncHash: header.syncHash, checkpoints, outcome, orderIssued, shroud: latestShroud, host: runtime.program.HostStatus() })}`)
process.exit(0)
