#!/usr/bin/env node
// Real, unmodified OpenRA WASM economy: spend initial cash, harvest, unload, then
// finish a building paid entirely from stored ore. No cheats or mocked currency.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transform } from 'esbuild'
import { bootRuntime, configFor, waitForSnapshot } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const TOOL = 'economygate'
const source = readFileSync(resolve(import.meta.dirname, '../src/core/snapshot.ts'), 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
const { SnapshotDecoder, PlayerFlag, ProductionItemFlag } = await import(
	`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`)
const decoder = new SnapshotDecoder()
const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps.find(candidate => candidate.title === 'Doubles')
if (!map) throw new Error(`${TOOL}: pinned Doubles map is unavailable`)
const config = configFor(catalog, map, { randomSeed: 104729, withBot: false })
config.gameSpeed = catalog.gameSpeeds.find(speed => speed.id === 'fastest')?.id ?? config.gameSpeed
for (const [key, value] of [['startingcash', '2500'], ['fog', 'False'], ['explored', 'True'], ['crates', 'False']]) {
	const option = map.options.find(candidate => candidate.id.toLowerCase() === key)
	const choice = option?.values.find(candidate => candidate.id.toLowerCase() === value.toLowerCase())
	if (!option || option.isLocked || !choice) throw new Error(`${TOOL}: unavailable option ${key}=${value}`)
	config.options[option.id] = choice.id
}
const started = runtime.bridge.startSkirmish(config)
if (started.status !== 'loading') throw new Error(`${TOOL}: start failed ${JSON.stringify(started)}`)

let snap = null
let names = []
let lastProgressTick = -500
let previousDensity = null
let resourceDecreases = 0
let resourceClears = 0
const deadline = Date.now() + 300000
await until('initial world', () => snap?.tick >= 5)
const initial = balance()
if (initial.cash !== 2500 || initial.resources !== 0) throw new Error(`${TOOL}: unexpected starting funds ${JSON.stringify(initial)}`)
const mcv = owned('mcv')[0]
if (!mcv) throw new Error(`${TOOL}: no local MCV`)
issue('DeployTransform', { subjectIds: Uint32Array.of(mcv.id) })
await until('construction yard', () => owned('fact').length === 1)
const base = owned('fact')[0]

// This legal base costs exactly the selected $2500 start: 300 + 500 + 300 + 1400.
// Delay the refinery until last so there can be no harvesting income before cash=0.
await buildAndPlace('powr', base, true)
const infantryProducer = ['tent', 'barr'].find(name => itemFor(name)?.item.flags & ProductionItemFlag.buildable)
if (!infantryProducer) throw new Error(`${TOOL}: no faction infantry producer is buildable`)
await buildAndPlace(infantryProducer, base)
await buildAndPlace('powr', base)
await buildAndPlace('proc', base)
if (balance().cash !== 0) throw new Error(`${TOOL}: preparation did not exhaust initial cash: ${JSON.stringify(balance())}`)

await until('free refinery harvester', () => owned('harv').length === 1)
const harvester = owned('harv')[0]
const harvestOrigin = [harvester.x, harvester.y]
let maximumTravel = 0
await until('automatic harvest and refinery delivery', () => {
	const truck = owned('harv')[0]
	if (truck) maximumTravel = Math.max(maximumTravel, Math.hypot(truck.x - harvestOrigin[0], truck.y - harvestOrigin[1]))
	if (balance().cash !== 0) throw new Error(`${TOOL}: unexpected cash injection while harvesting`)
	return balance().resources >= 200
})
if (maximumTravel < 1) throw new Error(`${TOOL}: no harvester travel was witnessed`)
issue('Stop', { subjectIds: Uint32Array.of(harvester.id) })
const stopTick = snap.tick
await until('harvester stop processed', () => snap.tick >= stopTick + 15)
const beforeSpend = balance()
const silo = itemFor('silo')
if (!silo || silo.item.cost !== 150) throw new Error(`${TOOL}: pinned silo cost changed`)
issue('StartProduction', { targetString: 'silo', extraData: 1 })
let paidOre = 0
let previousOre = beforeSpend.resources
await until('ore-funded silo ready', () => {
	const funds = balance()
	if (funds.cash !== 0) throw new Error(`${TOOL}: ore-funded production unexpectedly received cash`)
	if (funds.resources < previousOre) paidOre += previousOre - funds.resources
	previousOre = funds.resources
	return (itemFor('silo')?.item.flags & ProductionItemFlag.ready) !== 0
})
if (paidOre !== 150) throw new Error(`${TOOL}: silo consumed ${paidOre} ore credits, expected 150`)
if (resourceDecreases === 0 || resourceClears === 0)
	throw new Error(`${TOOL}: live resource snapshot did not report harvesting/depletion: ${resourceDecreases}/${resourceClears}`)
await placeReady('silo', base)
console.log(`${TOOL}: PASS — initial $2500 spent through OpenRA; free truck moved ${maximumTravel.toFixed(1)} cells, ` +
	`unloaded ${beforeSpend.resources} ore credits with cash=0; $150 silo completed and placed using ore alone; ` +
	`${resourceDecreases} visible resource decreases/${resourceClears} cleared cells (tick ${snap.tick})`)
process.exit(0)

async function until(label, predicate) {
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`${TOOL}: timed out during ${label}, tick=${snap?.tick} funds=${JSON.stringify(snap ? balance() : null)}`)
		await waitForSnapshot(runtime, {
			minimumTick: (snap?.tick ?? 0) + 1,
			timeoutMs: 30000,
			onSnapshot(_header, bytes) {
				snap = decoder.decode(bytes)
				names = runtime.bridge.snapshotTypeTable().split('\n')
				if (!snap.resources) throw new Error(`${TOOL}: live resource snapshot is absent`)
				const density = snap.resources.density
				if (!previousDensity) previousDensity = density.slice()
				for (let i = 0; i < density.length; i++) {
					if (density[i] < previousDensity[i]) {
						resourceDecreases++
						if (density[i] === 0) resourceClears++
					}
					previousDensity[i] = density[i]
				}
			},
		})
		if (snap.tick - lastProgressTick >= 500) {
			console.log(`${TOOL}: ${label}, tick=${snap.tick} cash=${balance().cash} ore=${balance().resources}`)
			lastProgressTick = snap.tick
		}
	}
}

function balance() {
	const player = snap.players.find(candidate => (candidate.flags & PlayerFlag.isRenderPlayer) !== 0)
	if (!player) throw new Error(`${TOOL}: no render player`)
	return { cash: player.cash, resources: player.resources }
}

function owned(type) {
	const actors = snap.actors
	const result = []
	for (let i = 0; i < actors.count; i++)
		if (actors.owner[i] === snap.world.renderPlayer && names[actors.typeId[i]] === type)
			result.push({ id: actors.id[i], x: actors.posX[i] / 1024, y: actors.posY[i] / 1024 })
	return result
}

function itemFor(name) {
	for (const queue of snap.production) {
		if (queue.playerId !== snap.world.renderPlayer) continue
		const item = queue.items.find(candidate => names[candidate.actorType] === name)
		if (item) return { queue, item }
	}
	return null
}

function issue(orderString, overrides = {}) {
	const result = runtime.bridge.issueOrder({ orderString, subjectIds: new Uint32Array(0), ...overrides })
	if (!result.startsWith('ok:')) throw new Error(`${TOOL}: ${orderString} rejected: ${result}`)
}

async function buildAndPlace(name, base, repeatClicks = false) {
	await until(`${name} available`, () => (itemFor(name)?.item.flags & ProductionItemFlag.buildable) !== 0)
	issue('StartProduction', { targetString: name, extraData: 1 })
	if (repeatClicks) {
		await until(`${name} started`, () => (itemFor(name)?.queue.progressPermille ?? 0) >= 100)
		for (let click = 0; click < 2; click++)
			issue('StartProduction', { targetString: name, extraData: 1, queued: true })
	}
	let previousProgress = 0
	await until(`${name} ready`, () => {
		const current = itemFor(name)
		if (repeatClicks && current.queue.progressPermille < previousProgress)
			throw new Error(`${TOOL}: repeated clicks reset ${name} progress`)
		previousProgress = current.queue.progressPermille
		return (current.item.flags & ProductionItemFlag.ready) !== 0
	})
	if (repeatClicks) {
		if (itemFor(name).item.queued !== 3) throw new Error(`${TOOL}: repeated clicks did not queue three ${name} items`)
		issue('CancelProduction', { targetString: name, extraData: 2 })
		await until(`${name} waiting copies removed`, () => itemFor(name).item.queued === 1)
		if ((itemFor(name).item.flags & ProductionItemFlag.ready) === 0)
			throw new Error(`${TOOL}: canceling waiting copies discarded the ready ${name}`)
		console.log(`${TOOL}: repeated production clicks preserved progress and reached ready; waiting copies canceled independently`)
	}
	await placeReady(name, base)
}

async function placeReady(name, base) {
	const beforeCount = owned(name).length
	const request = { queueId: itemFor(name).queue.queueId, actorType: name, cellX: 0, cellY: 0 }
	let placement = null
	for (let radius = 2; radius <= 12 && !placement; radius++)
		for (let dy = -radius; dy <= radius && !placement; dy++)
			for (let dx = -radius; dx <= radius && !placement; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
				request.cellX = Math.floor(base.x) + dx
				request.cellY = Math.floor(base.y) + dy
				if (runtime.bridge.queryBuildingPlacement(request).valid) placement = { ...request }
			}
	if (!placement) throw new Error(`${TOOL}: no legal ${name} placement near base`)
	const result = runtime.bridge.placeBuildingValidated(placement)
	if (!result.issued) throw new Error(`${TOOL}: ${name} placement rejected: ${JSON.stringify(result)}`)
	await until(`${name} placed`, () => owned(name).length > beforeCount)
}
