#!/usr/bin/env node

import { actorIdsOwnedBy, bootRuntime, configFor, renderPlayerIndex, waitForSnapshot } from './runtime-fixture.mjs'

const seed = Number(process.argv.find(value => value.startsWith('--seed='))?.slice(7) ?? 104729)
const targetTick = Number(process.argv.find(value => value.startsWith('--tick='))?.slice(7) ?? 1200)
const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps
	.filter(candidate => candidate.slots.length >= 2 && candidate.slots.slice(1).some(slot => slot.allowBots))
	.sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height || a.uid.localeCompare(b.uid))[0]
if (map == null) throw new Error('aidynamicrun: no bot-capable skirmish map')

const config = configFor(catalog, map, { randomSeed: seed })
const fastest = catalog.gameSpeeds.find(speed => speed.id === 'fastest')
if (fastest) config.gameSpeed = fastest.id
setBooleanOption(config, map, 'fog', false)
setBooleanOption(config, map, 'explored', true)
setBooleanOption(config, map, 'crates', false)
setBooleanOption(config, map, 'shortgame', false)
setOption(config, map, 'startingunits', 'light')
setMaximumNumericOption(config, map, 'startingcash')
const started = runtime.bridge.startSkirmish(config)
if (started.status !== 'loading') throw new Error(`aidynamicrun: start failed ${JSON.stringify(started)}`)

const checkpoints = []
const botTypes = new Set()
const combatTypes = new Set(['e1', 'e2', 'e3', 'e4', 'e6', 'e7', '1tnk', '2tnk', '3tnk', '4tnk', 'jeep', 'apc', 'arty', 'v2rl', 'ttnk', 'dtrk'])
let lastSampledTick = -1
let orderResult = ''
let initialBotActors = -1
let maxBotActors = 0
let maxBotCombat = 0
let maxMovingCombat = 0
let botQueuedSamples = 0
let botMovingSamples = 0
let botFiringSamples = 0
let botCashMin = Number.POSITIVE_INFINITY
let botCashMax = 0
let botResourcesMax = 0
let sawHarvester = false
let sawStructure = false
const eventCounts = { weaponFire: 0, actorDamaged: 0, actorDestroyed: 0, productionComplete: 0 }

const { header } = await waitForSnapshot(runtime, {
	minimumTick: targetTick,
	timeoutMs: Math.max(60000, targetTick * 120),
	onSnapshot(current) {
		if (current.tick === lastSampledTick) return
		lastSampledTick = current.tick
		if (current.tick > 0 && current.tick % 100 === 0) checkpoints.push([current.tick, current.syncHash])
		const world = current.sections.get(0)
		const actors = current.sections.get(3)
		const playerSection = current.sections.get(8)
		const production = current.sections.get(9)
		const events = current.sections.get(7)
		if (!world || !actors || !playerSection || !production || !events) throw new Error(`required ABI section absent at tick ${current.tick}`)
		const view = current.view
		let eventCursor = events.offset + 4
		for (let index = 0; index < view.getUint32(events.offset, true); index++) {
			const kind = view.getUint16(eventCursor, true)
			const payloadLength = view.getUint16(eventCursor + 2, true)
			if (kind === 1) eventCounts.weaponFire++
			else if (kind === 4) eventCounts.actorDamaged++
			else if (kind === 5) eventCounts.actorDestroyed++
			else if (kind === 8) eventCounts.productionComplete++
			eventCursor = (eventCursor + 4 + payloadLength + 3) & ~3
		}
		const players = parsePlayers(view, playerSection)
		const botIndexes = new Set(players.flatMap((player, index) => player.bot ? [index] : []))
		for (const index of botIndexes) {
			botCashMin = Math.min(botCashMin, players[index].cash)
			botCashMax = Math.max(botCashMax, players[index].cash)
			botResourcesMax = Math.max(botResourcesMax, players[index].resources)
		}

		const actorData = parseActors(view, actors)
		const names = runtime.bridge.snapshotTypeTable().split('\n')
		let botActors = 0
		let botCombat = 0
		let movingCombat = 0
		for (let index = 0; index < actorData.count; index++) {
			if (!botIndexes.has(actorData.owner[index])) continue
			botActors++
			const name = names[actorData.type[index]] ?? ''
			if (name) botTypes.add(name)
			if (name === 'harv') sawHarvester = true
			if (['fact', 'powr', 'proc', 'tent', 'barr', 'weap'].includes(name)) sawStructure = true
			const flags = actorData.flags[index]
			if ((flags & 64) !== 0) botMovingSamples++
			if ((flags & 32) !== 0) botFiringSamples++
			if (combatTypes.has(name)) {
				botCombat++
				if ((flags & 64) !== 0) movingCombat++
			}
		}
		if (initialBotActors < 0) initialBotActors = botActors
		maxBotActors = Math.max(maxBotActors, botActors)
		maxBotCombat = Math.max(maxBotCombat, botCombat)
		maxMovingCombat = Math.max(maxMovingCombat, movingCombat)

		let cursor = production.offset + 4
		const queueCount = view.getUint32(production.offset, true)
		for (let index = 0; index < queueCount; index++) {
			const player = view.getUint8(cursor)
			const queued = view.getUint16(cursor + 8, true)
			const itemCount = view.getUint16(cursor + 10, true)
			if (botIndexes.has(player) && queued > 0) botQueuedSamples++
			cursor += 12 + itemCount * 12
		}

		if (!orderResult && current.tick >= 10) {
			const local = renderPlayerIndex(current)
			const localIds = actorIdsOwnedBy(current, local)
			const localMcv = findActor(actorData, names, owner => owner === local, 'mcv')
			const botMcv = findActor(actorData, names, owner => botIndexes.has(owner), 'mcv')
			const localCombat = findActorInSet(actorData, names, owner => owner === local, combatTypes)
			const botCombat = findActorInSet(actorData, names, owner => botIndexes.has(owner), combatTypes)
			if (localIds.length > 0) {
				const left = view.getInt32(world.offset, true), top = view.getInt32(world.offset + 4, true)
				const right = view.getInt32(world.offset + 8, true), bottom = view.getInt32(world.offset + 12, true)
				const subjectIndex = localCombat >= 0 ? localCombat : localMcv
				const targetIndex = botCombat >= 0 ? botCombat : botMcv
				const subject = subjectIndex < 0 ? localIds[0] : actorData.id[subjectIndex]
				const targetX = targetIndex < 0 ? Math.floor((left + right) / 2) : Math.floor(actorData.x[targetIndex] / 1024)
				const targetY = targetIndex < 0 ? Math.floor((top + bottom) / 2) : Math.floor(actorData.y[targetIndex] / 1024)
				orderResult = runtime.bridge.issueOrder({
					orderString: localCombat >= 0 ? 'AttackMove' : 'Move', subjectIds: Uint32Array.of(subject), targetActorId: 0,
					targetCellX: targetX, targetCellY: targetY,
					queued: false, targetString: '', extraData: 0,
				})
			}
		}
	},
})

console.log(`AIRESULT ${JSON.stringify({ map: map.uid, seed, tick: header.tick, syncHash: header.syncHash, checkpoints,
	orderResult, initialBotActors, maxBotActors, maxBotCombat, maxMovingCombat, botQueuedSamples, botMovingSamples,
	botFiringSamples, botCashMin, botCashMax, botResourcesMax, sawHarvester, sawStructure,
	eventCounts,
	botTypes: [...botTypes].sort(), host: runtime.program.HostStatus() })}`)
process.exit(0)

function setBooleanOption(config, descriptor, id, desired) {
	const option = descriptor.options.find(candidate => candidate.id.toLowerCase() === id)
	if (!option || option.isLocked) return
	const value = option.values.find(candidate => candidate.id.toLowerCase() === String(desired).toLowerCase())
	if (value) config.options[option.id] = value.id
}

function setMaximumNumericOption(config, descriptor, id) {
	const option = descriptor.options.find(candidate => candidate.id.toLowerCase() === id)
	if (!option || option.isLocked) return
	const values = option.values.map(candidate => Number(candidate.id)).filter(Number.isFinite)
	if (values.length > 0) config.options[option.id] = String(Math.max(...values))
}

function setOption(config, descriptor, id, desired) {
	const option = descriptor.options.find(candidate => candidate.id.toLowerCase() === id)
	if (!option || option.isLocked) return
	const value = option.values.find(candidate => candidate.id.toLowerCase() === desired.toLowerCase())
	if (value) config.options[option.id] = value.id
}

function findActor(actors, names, ownerPredicate, type) {
	for (let index = 0; index < actors.count; index++)
		if (ownerPredicate(actors.owner[index]) && names[actors.type[index]] === type) return index
	return -1
}

function findActorInSet(actors, names, ownerPredicate, types) {
	for (let index = 0; index < actors.count; index++)
		if (ownerPredicate(actors.owner[index]) && types.has(names[actors.type[index]])) return index
	return -1
}

function parsePlayers(view, section) {
	const players = []
	let cursor = section.offset + 4
	for (let index = 0; index < view.getUint32(section.offset, true); index++) {
		const queueCount = view.getUint16(cursor + 30, true)
		players.push({
			cash: view.getUint32(cursor, true), resources: view.getUint32(cursor + 4, true),
			bot: (view.getUint8(cursor + 21) & 4) !== 0,
		})
		cursor += 36 + queueCount * 8
	}
	return players
}

function parseActors(view, section) {
	const count = view.getUint32(section.offset, true)
	let cursor = section.offset + 8
	const id = new Uint32Array(count)
	for (let index = 0; index < count; index++, cursor += 4) id[index] = view.getUint32(cursor, true)
	const x = new Int32Array(count)
	for (let index = 0; index < count; index++, cursor += 4) x[index] = view.getInt32(cursor, true)
	const y = new Int32Array(count)
	for (let index = 0; index < count; index++, cursor += 4) y[index] = view.getInt32(cursor, true)
	cursor += count * 4
	const type = new Uint16Array(count)
	for (let index = 0; index < count; index++, cursor += 2) type[index] = view.getUint16(cursor, true)
	cursor += count * 10
	cursor = (cursor + 3) & ~3
	const owner = new Uint8Array(count)
	for (let index = 0; index < count; index++) owner[index] = view.getUint8(cursor + index)
	const flags = new Uint8Array(count)
	const flagsOffset = cursor + count * 4
	for (let index = 0; index < count; index++) flags[index] = view.getUint8(flagsOffset + index)
	return { count, id, x, y, type, owner, flags }
}
