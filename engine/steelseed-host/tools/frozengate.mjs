#!/usr/bin/env node

import { bootRuntime, configFor, waitForSnapshot } from './runtime-fixture.mjs'
import { fail } from './gate-lib.mjs'

const TOOL = 'frozengate'
const falsify = process.argv.includes('--falsify=visible')
const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps.find(candidate => candidate.title === 'Marigold Town')
if (!map) fail(TOOL, 'Marigold Town witness map is absent')
const config = configFor(catalog, map, { randomSeed: 104729, withBot: false })
setBooleanOption(config, map, 'explored', true)
setBooleanOption(config, map, 'fog', true)
const started = runtime.bridge.startSkirmish(config)
if (started.status !== 'loading') fail(TOOL, `start returned ${started.status}/${started.code}`)

const { header } = await waitForSnapshot(runtime, { minimumTick: 5 })
const frozenSection = header.sections.get(10)
const actorSection = header.sections.get(3)
const playerSection = header.sections.get(8)
const shroudSection = header.sections.get(6)
const worldSection = header.sections.get(0)
if (!frozenSection || !actorSection || !playerSection || !shroudSection || !worldSection)
	fail(TOOL, 'required world/actor/shroud/player/frozen section is absent')

const view = header.view
const count = view.getUint32(frozenSection.offset, true)
if (count === 0) fail(TOOL, 'explored witness map published no OpenRA FrozenUnderFog structures')
const liveCount = view.getUint32(actorSection.offset, true)
const liveIds = new Set()
for (let index = 0; index < liveCount; index++) liveIds.add(view.getUint32(actorSection.offset + 8 + index * 4, true))
const playerCount = view.getUint32(playerSection.offset, true)
const names = runtime.bridge.snapshotTypeTable().split('\n')

let cursor = frozenSection.offset + 4
const idOffset = cursor; cursor += count * 4
const xOffset = cursor; cursor += count * 4
const yOffset = cursor; cursor += count * 4
cursor += count * 4
const typeOffset = cursor; cursor += count * 2
const ownerOffset = (cursor + 3) & ~3
const healthOffset = ownerOffset + count
const left = view.getInt32(worldSection.offset, true)
const top = view.getInt32(worldSection.offset + 4, true)
const right = view.getInt32(worldSection.offset + 8, true)
const bottom = view.getInt32(worldSection.offset + 12, true)
const width = right - left
let explored = 0
for (let index = 0; index < count; index++) {
	const id = view.getUint32(idOffset + index * 4, true)
	if (liveIds.has(id)) fail(TOOL, `remembered actor ${id} also appears as a live visible actor`)
	const type = view.getUint16(typeOffset + index * 2, true)
	if (!names[type]) fail(TOOL, `remembered actor ${id} has unknown type ${type}`)
	const owner = view.getUint8(ownerOffset + index)
	if (owner !== 255 && owner >= playerCount) fail(TOOL, `remembered actor ${id} owner ${owner} is outside player table`)
	view.getUint8(healthOffset + index) // Layout witness: every cached health byte is addressable.
	const x = Math.floor(view.getInt32(xOffset + index * 4, true) / 1024)
	const y = Math.floor(view.getInt32(yOffset + index * 4, true) / 1024)
	if (x < left || x >= right || y < top || y >= bottom) fail(TOOL, `remembered actor ${id} lies outside map bounds`)
	let state = shroudState(view, shroudSection, (y - top) * width + x - left)
	if (falsify && index === 0) state = 2
	if (state !== 1) fail(TOOL, `remembered actor ${id} is in shroud state ${state}, expected explored/last-known`)
	explored++
}

console.log(`${TOOL}: PASS — ${explored} OpenRA FrozenUnderFog structures are last-known, non-live and confined to explored fog`)
process.exit(0)

function shroudState(view, section, cellIndex) {
	const count = view.getUint32(section.offset, true)
	for (let index = 0; index < count; index++) {
		const offset = section.offset + 4 + index * 8
		const start = view.getUint32(offset, true)
		const length = view.getUint16(offset + 4, true)
		if (cellIndex >= start && cellIndex < start + length) return view.getUint8(offset + 6)
	}
	return 0
}

function setBooleanOption(config, descriptor, id, desired) {
	const option = descriptor.options.find(candidate => candidate.id.toLowerCase() === id)
	if (!option || option.isLocked) fail(TOOL, `${id} option is unavailable or locked on witness map`)
	const value = option.values.find(candidate => candidate.id.toLowerCase() === String(desired).toLowerCase())
	if (!value) fail(TOOL, `${id} option has no ${desired} value`)
	config.options[option.id] = value.id
}
