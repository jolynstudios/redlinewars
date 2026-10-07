#!/usr/bin/env node
// STEELSEED — spy power-outage gate (vfx.md Epic 3, scenario S01).
//
// Real shipping host and stock OpenRA traits, with fog ON, through the bridge calls the page
// makes (queryContextOrder for the cursor, issueContextOrder for the click). Only the in-memory
// fixture map changes. PASS requires:
//   - a spy offered its own power plant gets no Infiltrate and is not consumed;
//   - a spy clicked onto an enemy Power Plant (POWR), and later an Advanced Power Plant
//     (APWR), is ordered to Infiltrate and enters;
//   - the victim's grid goes dark: its powered radar dome, in our sight, turns disabled (the
//     rules' own condition, which the snapshot publishes). The victim's power totals are withheld
//     from every other client (foggate case 6), so the dark structure is what the spy's side sees;
//   - and it recovers after the resolved outage (InfiltrateForPowerOutage, 500 ticks).
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../../web/node_modules/esbuild/lib/main.js'
import { bootVfsRuntime } from './runtime-vfs-fixture.mjs'
import { configFor, waitForSnapshot } from './runtime-fixture.mjs'

const OUTAGE_TICKS = 500
const root = resolve(import.meta.dirname, '../../..'), out = join(root, '.artifacts/spy-outage')
mkdirSync(out, { recursive: true })
const bundled = await build({ stdin: { contents: "export {SnapshotDecoder} from './src/core/snapshot'", resolveDir: join(root, 'web') }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' })
const decoderModule = { exports: {} }; new Function('module', 'exports', bundled.outputFiles[0].text)(decoderModule, decoderModule.exports)
const decoder = new decoderModule.exports.SnapshotDecoder()

const runtime = await bootVfsRuntime(fs => {
	const dir = '/openra/engine/mods/ra/maps/doubles', file = dir + '/map.yaml'
	const text = fs.readFile(file, { encoding: 'utf8' })
	const actors = [
		['Spawn0', 'mpspawn', 'Neutral', 80, 40], ['Spawn1', 'mpspawn', 'Neutral', 100, 40],
		['Spawn2', 'mpspawn', 'Neutral', 80, 46], ['Spawn3', 'mpspawn', 'Neutral', 100, 46],
		['SpyA', 'spy', 'Multi0', 22, 19], ['SpyB', 'spy', 'Multi0', 22, 29],
		['WatchA', '1tnk', 'Multi0', 22, 21], ['WatchB', '1tnk', 'Multi0', 22, 31],
		['OwnPlant', 'powr', 'Multi0', 16, 19],
		['EnemyPlant', 'powr', 'Multi1', 26, 18], ['EnemyAdvancedPlant', 'apwr', 'Multi1', 26, 28],
		// A powered structure in our sight: the outage turns it dark.
		['EnemyDome', 'dome', 'Multi1', 26, 23],
		['EnemyBarracks', 'barr', 'Multi1', 94, 44],
	]
	fs.writeFile(file, text.split('\nActors:\n')[0] + '\nActors:\n'
		+ actors.map(([id, type, owner, x, y]) => `\t${id}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${x},${y}\n`).join(''))
	const width = 112, height = 54, n = width * height, terrain = new Uint8Array(5 + n * 5), view = new DataView(terrain.buffer)
	terrain[0] = 1; view.setUint16(1, width, true); view.setUint16(3, height, true)
	for (let i = 0; i < n; i++) view.setUint16(5 + i * 3, 255, true)
	fs.writeFile(dir + '/map.bin', terrain)
})

const catalog = runtime.bridge.getSkirmishCatalog(), map = catalog.maps.find(m => m.title === 'Doubles')
assert.ok(map, 'Doubles map missing from the skirmish catalog')
const config = configFor(catalog, map, { withBot: true })
config.options.explored = 'True'; config.options.fog = 'True'
config.local.faction = 'england'; config.slots[0].faction = 'england'; config.slots[1].faction = 'russia'
assert.equal(runtime.bridge.startSkirmish(config).status, 'loading')

let snap = null, names = null
const observe = (_header, bytes) => { snap = decoder.decode(bytes); names ??= runtime.bridge.snapshotTypeTable().split('\n') }
await waitForSnapshot(runtime, { minimumTick: 20, onSnapshot: observe })
const byId = id => { const a = snap.actors; for (let i = 0; i < a.count; i++) if (a.id[i] === id) return i; return -1 }
function actor(type, x, y) {
	const a = snap.actors
	for (let i = 0; i < a.count; i++)
		if (names[a.typeId[i]] === type && Math.abs(a.posX[i] / 1024 - x) < 2.5 && Math.abs(a.posY[i] / 1024 - y) < 2.5)
			return { id: a.id[i], owner: a.owner[i], x: a.posX[i] / 1024, y: a.posY[i] / 1024 }
	return null
}
const spyA = actor('spy', 22.5, 19.5), spyB = actor('spy', 22.5, 29.5), own = actor('powr', 17, 20.5)
const plant = actor('powr', 27, 19.5), advanced = actor('apwr', 27.5, 29.5)
assert.ok(spyA && spyB && own && plant && advanced, `fixture actors missing: ${JSON.stringify({ spyA, spyB, own, plant, advanced })}`)
// The rules' `disabled` condition (ActorFlag.disabled, bit 0) on the victim's dome: dark = 0.
const dome = actor('dome', 27, 24)
assert.ok(dome, 'the enemy dome must be in our sight')
const supplied = () => { const i = byId(dome.id); return i < 0 ? null : (snap.actors.flags[i] & 1) === 0 ? 1 : 0 }
const intent = (subject, target) => ({ subjectIds: Uint32Array.of(subject.id), subjectCount: 1,
	targetActorId: target.id, targetCellX: Math.floor(target.x), targetCellY: Math.floor(target.y), targetFrozen: false, modifiers: 0 })
const report = { ownPreview: null, phases: [] }

// A spy offered its own plant: no Infiltrate, and it stays in the world.
report.ownPreview = runtime.bridge.queryContextOrder(intent(spyA, own))
assert.notEqual(report.ownPreview?.order, 'Infiltrate', 'a spy must not be offered its own power plant')

async function infiltrate(spy, target, label) {
	const phase = { label, before: supplied(), preview: runtime.bridge.queryContextOrder(intent(spy, target)), order: null,
		enteredTick: null, darkTick: null, recoveredTick: null }
	report.phases.push(phase)
	phase.order = runtime.bridge.issueContextOrder(intent(spy, target))
	const deadline = snap.tick + 400 + OUTAGE_TICKS + 200
	while (snap.tick < deadline && phase.recoveredTick === null) {
		await waitForSnapshot(runtime, { minimumTick: snap.tick + 1, timeoutMs: 30_000, onSnapshot: observe })
		if (phase.enteredTick === null && byId(spy.id) < 0) phase.enteredTick = snap.tick
		const now = supplied()
		if (phase.darkTick === null && phase.enteredTick !== null && now === 0) phase.darkTick = snap.tick
		// Powered again: the dome's disabled condition clears when the outage ends.
		if (phase.darkTick !== null && now > 0) phase.recoveredTick = snap.tick
	}
	return phase
}
const first = await infiltrate(spyA, plant, 'POWR')
const second = await infiltrate(spyB, advanced, 'APWR')
writeFileSync(join(out, 'engine-report.json'), JSON.stringify(report, null, 2) + '\n')
console.log('spyoutagegate', JSON.stringify(report))
for (const phase of [first, second]) {
	assert.equal(phase.preview?.order, 'Infiltrate', `${phase.label}: the cursor must offer Infiltrate, got ${JSON.stringify(phase.preview)}`)
	assert.match(phase.order, /^ok:.*\(Infiltrate\)/, `${phase.label}: the click must order Infiltrate: ${phase.order}`)
	assert.ok(phase.before > 0, `${phase.label}: the victim's dome was dark before the spy went in (${phase.before})`)
	assert.ok(phase.enteredTick !== null, `${phase.label}: the spy never entered`)
	assert.ok(phase.darkTick !== null, `${phase.label}: the victim's grid never went dark after the infiltration`)
	assert.ok(phase.recoveredTick !== null, `${phase.label}: the victim's grid never recovered`)
	const length = phase.recoveredTick - phase.darkTick
	assert.ok(Math.abs(length - OUTAGE_TICKS) <= 30, `${phase.label}: outage lasted ${length} ticks, rules say ${OUTAGE_TICKS}`)
}
assert.ok(byId(spyA.id) < 0 && byId(spyB.id) < 0, 'both spies were consumed by their infiltrations')
console.log('SPY_OUTAGE_GATE_PASS', JSON.stringify(report.phases.map(p => ({ label: p.label, before: p.before, dark: p.darkTick, recovered: p.recoveredTick }))))
process.exit(0)
