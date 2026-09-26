#!/usr/bin/env node

import { bootRuntime, configFor, renderPlayerIndex, waitForSnapshot } from './runtime-fixture.mjs'
import { fail } from './gate-lib.mjs'

const TOOL = 'deploygate'
const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps.find(candidate => candidate.title === 'Doubles') ?? catalog.maps[0]
const config = configFor(catalog, map, { randomSeed: 104729, withBot: false })
const started = runtime.bridge.startSkirmish(config)
if (started.status !== 'loading') fail(TOOL, `start returned ${started.status}/${started.code}`)

const initial = await waitForSnapshot(runtime, { minimumTick: 5 })
const before = parseActors(initial.header)
const typeNames = runtime.bridge.snapshotTypeTable().split('\n')
const local = renderPlayerIndex(initial.header)
const mcv = findOwnedType(before, typeNames, local, 'mcv')
if (mcv < 0) fail(TOOL, 'local OpenRA player has no visible MCV')
if ((before.flags[mcv] & 16) === 0) fail(TOOL, 'MCV does not publish the authoritative deployable actor flag')

const result = runtime.bridge.issueOrder({
	orderString: 'DeployTransform',
	subjectIds: Uint32Array.of(before.id[mcv]),
	targetActorId: 0,
	targetCellX: -1,
	targetCellY: -1,
	queued: false,
	targetString: '',
	extraData: 0,
})
if (!String(result).startsWith('ok: issued 1/1')) fail(TOOL, `bridge rejected local deploy order: ${result}`)

const afterResult = await waitForSnapshot(runtime, { minimumTick: initial.header.tick + 30 })
const after = parseActors(afterResult.header)
const afterNames = runtime.bridge.snapshotTypeTable().split('\n')
if (findOwnedType(after, afterNames, local, 'mcv') >= 0) fail(TOOL, 'MCV remained after DeployTransform')
if (findOwnedType(after, afterNames, local, 'fact') < 0) fail(TOOL, 'DeployTransform did not create the construction yard')

const production = afterResult.header.sections.get(9)
if (!production || afterResult.header.view.getUint32(production.offset, true) === 0)
	fail(TOOL, 'construction yard did not expose OpenRA production queues')

console.log(`${TOOL}: PASS — authoritative deploy flag -> local DeployTransform -> mcv/fact lifecycle and production queues`)
process.exit(0)

function parseActors(header) {
	const section = header.sections.get(3)
	if (!section) fail(TOOL, 'actors section absent')
	const count = header.view.getUint32(section.offset, true)
	let cursor = section.offset + 8
	const id = new Uint32Array(count)
	for (let index = 0; index < count; index++, cursor += 4) id[index] = header.view.getUint32(cursor, true)
	cursor += count * 12
	const type = new Uint16Array(count)
	for (let index = 0; index < count; index++, cursor += 2) type[index] = header.view.getUint16(cursor, true)
	cursor += count * 10
	cursor = (cursor + 3) & ~3
	const owner = new Uint8Array(count)
	for (let index = 0; index < count; index++) owner[index] = header.view.getUint8(cursor + index)
	const flagsOffset = cursor + count * 4
	const flags = new Uint8Array(count)
	for (let index = 0; index < count; index++) flags[index] = header.view.getUint8(flagsOffset + index)
	return { count, id, type, owner, flags }
}

function findOwnedType(actors, names, owner, wanted) {
	for (let index = 0; index < actors.count; index++)
		if (actors.owner[index] === owner && names[actors.type[index]] === wanted) return index
	return -1
}
