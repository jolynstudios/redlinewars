#!/usr/bin/env node

import { bootRuntime, configFor, snapshotHeader, waitForSnapshot } from './runtime-fixture.mjs'
import { fail } from './gate-lib.mjs'

const TOOL = 'setupgate'
const full = process.argv.includes('--all-maps')
const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
if (typeof runtime.bridge.validateSkirmish !== 'function') fail(TOOL, 'cold validation bridge is missing')
if (catalog.schemaVersion !== 1) fail(TOOL, `catalog schema ${catalog.schemaVersion} != 1`)
if (catalog.maps.length !== 68) fail(TOOL, `catalog exposes ${catalog.maps.length} maps, expected 68`)
if (catalog.sessionTransports.local.supported !== true) fail(TOOL, 'local transport boundary is incorrect')
if (catalog.sessionTransports.network.supported !== true || catalog.sessionTransports.network.status !== 'available')
	fail(TOOL, `network transport boundary is incorrect: ${JSON.stringify(catalog.sessionTransports.network)}`)
if (!catalog.gameSpeeds.some(speed => speed.id === catalog.defaultGameSpeed)) fail(TOOL, 'default game speed is not catalogued')

let catalogSlots = 0
let catalogValues = 0
let validations = 0
const validate = (config, label) => {
	const validated = runtime.bridge.validateSkirmish(config)
	if (validated.status !== 'valid' || validated.code !== 'valid')
		fail(TOOL, `${label}: validation returned ${validated.status}/${validated.code}: ${validated.userMessage}`)
	validations++
}
for (const map of catalog.maps) {
	if (!map.uid || map.bounds.width <= 0 || map.bounds.height <= 0 || map.slots.length === 0)
		fail(TOOL, `${map.title}: incomplete map dimensions/slots`)
	if (!map.factions.some(faction => faction.id === 'Random')) fail(TOOL, `${map.title}: Random faction missing`)
	if (!map.bots.some(bot => bot.id === 'normal')) fail(TOOL, `${map.title}: normal OpenRA bot missing`)
	if (new Set(map.colors).size !== map.colors.length || map.colors.length < 2) fail(TOOL, `${map.title}: colors missing/equalized`)
	catalogSlots += map.slots.length
	for (const option of map.options) {
		if (!option.values.some(value => value.id === option.defaultValue)) fail(TOOL, `${map.title}:${option.id} default not in values`)
		catalogValues += option.values.length
	}

	// Exhaust every catalogued choice along each independent setup axis. Full Cartesian
	// multiplication would repeat the same OpenRA validator millions of times without adding
	// a new branch; this covers every map, human slot, controller kind, bot, faction, preset
	// color, UI team, spawn, speed, option and option value at least once.
	const baseConfig = configFor(catalog, map, { randomSeed: 104729, withBot: true })
	validate(baseConfig, `${map.title}:base`)

	for (let slotIndex = 0; slotIndex < map.slots.length; slotIndex++)
		validate(configFor(catalog, map, { humanSlot: slotIndex, variant: slotIndex, randomSeed: 104729 + slotIndex }),
			`${map.title}:human:${map.slots[slotIndex].id}`)

	const humanSlot = map.slots.find(slot => slot.id === baseConfig.local.slot)
	if (!humanSlot) fail(TOOL, `${map.title}: base human slot is absent from catalog`)
	if (!humanSlot.locks.faction) {
		for (const faction of map.factions) {
			const config = structuredClone(baseConfig)
			config.local.faction = faction.id
			validate(config, `${map.title}:faction:${faction.id}`)
		}
	}
	if (!humanSlot.locks.color) {
		for (const color of map.colors) {
			const config = structuredClone(baseConfig)
			config.local.color = color
			validate(config, `${map.title}:color:${color}`)
		}
	}
	if (!humanSlot.locks.team) {
		for (let team = 0; team <= 10; team++) {
			const config = structuredClone(baseConfig)
			config.local.team = team
			validate(config, `${map.title}:team:${team}`)
		}
	}
	if (!humanSlot.locks.spawn) {
		for (const spawn of [0, ...map.spawnPoints.map(point => point.id)]) {
			const config = structuredClone(baseConfig)
			config.local.spawn = spawn
			// Randomize unlocked bot spawns so the validator is exercising the requested human
			// spawn rather than rejecting an incidental duplicate preset.
			for (const slot of config.slots)
				if (slot.kind === 'bot' && !map.slots.find(item => item.id === slot.slot)?.locks.spawn) slot.spawn = 0
			const collidesWithLockedBot = config.slots.some(slot => slot.kind === 'bot' &&
				map.slots.find(item => item.id === slot.slot)?.locks.spawn && slot.spawn === spawn && spawn !== 0)
			if (!collidesWithLockedBot) validate(config, `${map.title}:spawn:${spawn}`)
		}
	}

	for (const speed of catalog.gameSpeeds) {
		const config = structuredClone(baseConfig)
		config.gameSpeed = speed.id
		validate(config, `${map.title}:speed:${speed.id}`)
	}
	for (const option of map.options) {
		if (option.id === 'gamespeed') continue
		for (const value of option.values) {
			if (option.isLocked && value.id !== option.defaultValue) continue
			const config = structuredClone(baseConfig)
			config.options[option.id] = value.id
			validate(config, `${map.title}:option:${option.id}=${value.id}`)
		}
	}

	for (const descriptor of map.slots) {
		if (descriptor.id === baseConfig.local.slot) continue
		const kinds = [
			...(descriptor.required ? [] : ['open', 'closed']),
			...(descriptor.allowBots ? ['bot'] : []),
		]
		for (const kind of kinds) {
			const config = structuredClone(baseConfig)
			const slot = config.slots.find(value => value.slot === descriptor.id)
			if (!slot) fail(TOOL, `${map.title}:${descriptor.id} omitted from normalized test config`)
			slot.kind = kind
			if (kind === 'bot') {
				slot.botType = map.bots[0].id
				slot.faction = descriptor.locks.faction ? descriptor.defaults.faction : 'Random'
				slot.color = descriptor.locks.color ? descriptor.defaults.color : map.colors[1 % map.colors.length]
				slot.team = descriptor.locks.team ? descriptor.defaults.team : 0
				slot.spawn = descriptor.locks.spawn ? descriptor.defaults.spawn : 0
			}
			validate(config, `${map.title}:slot:${descriptor.id}:${kind}`)
		}
		if (descriptor.allowBots) {
			for (const bot of map.bots) {
				const config = structuredClone(baseConfig)
				const slot = config.slots.find(value => value.slot === descriptor.id)
				slot.kind = 'bot'
				slot.botType = bot.id
				slot.faction = descriptor.locks.faction ? descriptor.defaults.faction : 'Random'
				slot.color = descriptor.locks.color ? descriptor.defaults.color : map.colors[1 % map.colors.length]
				slot.team = descriptor.locks.team ? descriptor.defaults.team : 0
				slot.spawn = descriptor.locks.spawn ? descriptor.defaults.spawn : 0
				validate(config, `${map.title}:slot:${descriptor.id}:bot:${bot.id}`)
			}
		}
	}
}

const base = configFor(catalog, catalog.maps[0])
let result = runtime.bridge.startSkirmish({ ...base, schemaVersion: 999 })
if (result.status !== 'error' || result.code !== 'unsupported-schema') fail(TOOL, 'unsupported schema did not return explicit error')
result = runtime.bridge.startSkirmish({ ...base, mapUid: 'not-a-real-map' })
if (result.status !== 'error' || result.code !== 'unknown-map') fail(TOOL, 'unknown map did not return explicit error')
result = runtime.bridge.startSkirmish({ ...base, options: { ...base.options, fog: 'maybe' } })
if (result.status !== 'error' || result.code !== 'invalid-option-value') fail(TOOL, 'invalid option did not return explicit error')

const maps = full ? catalog.maps : [catalog.maps[0], catalog.maps[Math.floor(catalog.maps.length / 2)], catalog.maps.at(-1)]
let starts = 0
for (let index = 0; index < maps.length; index++) {
	const map = maps[index]
	const config = configFor(catalog, map, { humanSlot: index, variant: index, randomSeed: 104729 + index })
	const started = runtime.bridge.startSkirmish(config)
	if (started.status !== 'loading') fail(TOOL, `${map.title}: start returned ${started.status}/${started.code}: ${started.userMessage}`)
	const { header } = await waitForSnapshot(runtime, { minimumTick: 1, timeoutMs: 20000 })
	if (snapshotHeader(new Uint8Array(header.view.buffer, header.view.byteOffset, header.length)).version !== 2)
		fail(TOOL, `${map.title}: did not produce ABI v2 snapshot`)
	starts++
}

console.log(`${TOOL}: PASS — catalog roundtrip 68 maps/${catalogSlots} slots/${catalogValues} lobby values, ${validations} exhaustive single-axis OpenRA validations, explicit invalid errors, ${starts} real local skirmish starts${full ? ' (all maps)' : ' (representative; use --all-maps for full start sweep)'}`)
process.exit(0)
