#!/usr/bin/env node
// STEELSEED — support power gate (vfx.md Epic 3).
//
// Real shipping host, stock OpenRA traits and the stock order: a support power fires as the
// plain order whose OrderString is the power key, issued on the PLAYER actor (zero subjects),
// because SupportPowerManager is a player-actor trait. Only test data changes, and only in the
// in-memory VFS: the fixture map's actors and terrain, plus a map rules block that shortens the
// Iron Curtain charge so the gate runs in seconds. Shipping files are never touched.
//
// PASS requires:
//   - the local player's Iron Curtain charges to ready;
//   - the player-actor order is accepted by the bridge;
//   - the simulation keeps ticking afterwards. Iron Curtain has DisplayRadarPing, and the
//     assetless rules strip the RadarPings world trait: SupportPower.Activate must cope with a
//     world that has no radar pings instead of halting on a NullReferenceException;
//   - the power's charge restarts, which is SupportPowerManager's proof the activation ran;
//   - Chronoshift, the two-cell power, moves the unit in its source footprint to the
//     destination when the order carries the source as ExtraLocation (the bridge's extra cell);
//   - the bot's own nuke (the stock SupportPowerBotModule decision; also DisplayRadarPing)
//     strikes the local base and the simulation keeps ticking through it;
//   - that detonation reaches the presentation as an impact event (kind 2) naming the
//     `atomic` weapon: the identity the mushroom cloud keys on, instead of a damage threshold.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../../web/node_modules/esbuild/lib/main.js'
import { bootVfsRuntime } from './runtime-vfs-fixture.mjs'
import { actorIdsOwnedBy, configFor, renderPlayerIndex, waitForSnapshot } from './runtime-fixture.mjs'

const CHARGE_TICKS = 100
// The bot's silo charges after the Iron Curtain phase is over, so the two stay separate.
const NUKE_CHARGE_TICKS = 400
const NUKE_DEADLINE_TICKS = 3000
const TARGET = { x: 30, y: 20 }
const CHRONO_SOURCE = { x: 40, y: 20 }, CHRONO_DEST = { x: 50, y: 26 }
const root = resolve(import.meta.dirname, '../../..'), out = join(root, '.artifacts/support-powers')
mkdirSync(out, { recursive: true })

const runtime = await bootVfsRuntime(fs => {
	const dir = '/openra/engine/mods/ra/maps/doubles', file = dir + '/map.yaml'
	const text = fs.readFile(file, { encoding: 'utf8' })
	const actors = [
		['Spawn0', 'mpspawn', 'Neutral', 80, 40], ['Spawn1', 'mpspawn', 'Neutral', 100, 40],
		['Spawn2', 'mpspawn', 'Neutral', 80, 46], ['Spawn3', 'mpspawn', 'Neutral', 100, 46],
		['Curtain', 'iron', 'Multi0', 20, 10], ['PowerA', 'apwr', 'Multi0', 24, 10], ['PowerB', 'apwr', 'Multi0', 28, 10],
		['Shielded', '3tnk', 'Multi0', TARGET.x, TARGET.y], ['PowerC', 'powr', 'Multi0', 22, 14],
		['Paradox', 'pdox', 'Multi0', 20, 26], ['PowerD', 'apwr', 'Multi0', 24, 26], ['PowerE', 'apwr', 'Multi0', 28, 26],
		['Jumper', '1tnk', 'Multi0', CHRONO_SOURCE.x, CHRONO_SOURCE.y],
		['EnemyPower', 'powr', 'Multi1', 90, 44], ['EnemyBarracks', 'barr', 'Multi1', 94, 44],
		// The bot's powered silo. Its nuke decision needs at least 3000 of enemy structure value
		// within 5 cells, which the local base above offers.
		['EnemySilo', 'mslo', 'Multi1', 92, 30], ['EnemyPowerA', 'apwr', 'Multi1', 86, 30], ['EnemyPowerB', 'apwr', 'Multi1', 96, 30],
	]
	const rules = `\nRules:\n\tIRON:\n\t\tGrantExternalConditionPower@IRONCURTAIN:\n\t\t\tChargeInterval: ${CHARGE_TICKS}\n`
		+ `\tMSLO:\n\t\tNukePower:\n\t\t\tChargeInterval: ${NUKE_CHARGE_TICKS}\n`
		+ `\tPDOX:\n\t\tChronoshiftPower@chronoshift:\n\t\t\tChargeInterval: ${CHARGE_TICKS}\n`
	fs.writeFile(file, text.split('\nActors:\n')[0] + '\nActors:\n'
		+ actors.map(([id, type, owner, x, y]) => `\t${id}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${x},${y}\n`).join('')
		+ rules)
	const width = 112, height = 54, n = width * height, terrain = new Uint8Array(5 + n * 5), view = new DataView(terrain.buffer)
	terrain[0] = 1; view.setUint16(1, width, true); view.setUint16(3, height, true)
	for (let i = 0; i < n; i++) view.setUint16(5 + i * 3, 255, true)
	fs.writeFile(dir + '/map.bin', terrain)
})

const catalog = runtime.bridge.getSkirmishCatalog(), map = catalog.maps.find(m => m.title === 'Doubles')
assert.ok(map, 'Doubles map missing from the skirmish catalog')
const config = configFor(catalog, map, { withBot: true })
config.options.explored = 'True'; config.options.fog = 'False'
config.local.faction = 'russia'; config.slots[0].faction = 'russia'; config.slots[1].faction = 'england'
assert.equal(runtime.bridge.startSkirmish(config).status, 'loading')

const bundled = await build({ stdin: { contents: "export {SnapshotDecoder} from './src/core/snapshot'", resolveDir: join(root, 'web') }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' })
const decoderModule = { exports: {} }; new Function('module', 'exports', bundled.outputFiles[0].text)(decoderModule, decoderModule.exports)
const decoder = new decoderModule.exports.SnapshotDecoder()
let tick = 0, header = null, atomicImpactTick = null, typeNames = null, lastBytes = null
// Section 7 is a tagged stream: [u16 kind][u16 length][payload], each record 4-byte aligned.
// A projectileImpact (kind 2) names its weapon's type-table id at payload offset 22.
function scanImpacts(latest) {
	const events = latest.sections.get(7)
	if (!events || atomicImpactTick !== null) return
	const view = latest.view, end = events.offset + events.byteLength
	let at = events.offset + 4
	for (let i = view.getUint32(events.offset, true); i > 0 && at + 4 <= end; i--) {
		const kind = view.getUint16(at, true), length = view.getUint16(at + 2, true)
		if (kind === 2 && length >= 24) {
			typeNames ??= runtime.bridge.snapshotTypeTable().split('\n')
			if (typeNames[view.getUint16(at + 4 + 22, true)]?.toLowerCase() === 'atomic') atomicImpactTick = latest.tick
		}
		at = (at + 4 + length + 3) & ~3
	}
}
const observe = (latest, bytes) => { tick = latest.tick; header = latest; lastBytes = bytes; scanImpacts(latest) }
// The local actor of a type, as the snapshot publishes it (cells, from WPos / 1024).
function findActor(type) {
	const snap = decoder.decode(lastBytes), names = runtime.bridge.snapshotTypeTable().split('\n'), a = snap.actors
	for (let i = 0; i < a.count; i++)
		if (names[a.typeId[i]] === type && a.owner[i] === snap.world.renderPlayer)
			return { id: a.id[i], x: a.posX[i] / 1024, y: a.posY[i] / 1024 }
	return null
}
await waitForSnapshot(runtime, { minimumTick: 5, onSnapshot: observe })

// OpenRA keys an unnamed power's order by its info type: IRON's only power is this one.
const curtain = () => runtime.bridge.getSupportPowers()?.powers?.find(p => p.key === 'GrantExternalConditionPowerInfoOrder')
const report = { chargeTicks: CHARGE_TICKS, target: TARGET, statusBefore: null, order: null, orderTick: 0, statusAfter: null, lastTick: 0, hostStatus: null, failure: null }
const deadline = performance.now() + 60_000
while (!curtain()?.ready) {
	assert.ok(performance.now() < deadline, `Iron Curtain never became ready: ${JSON.stringify(runtime.bridge.getSupportPowers())}`)
	await waitForSnapshot(runtime, { minimumTick: tick + 5, onSnapshot: observe })
}
report.statusBefore = curtain()
assert.equal(report.statusBefore.active, true, 'Iron Curtain must be powered (active) before firing')

report.orderTick = tick
report.order = runtime.bridge.issueOrder({
	orderString: report.statusBefore.key, subjectIds: new Uint32Array(0), subjectCount: 0,
	targetCellX: TARGET.x, targetCellY: TARGET.y,
})
// Watch every snapshot: the charge restarting (ready -> charging) is the activation's proof.
// The shortened charge refills within CHARGE_TICKS, so a single late sample would miss it.
report.restartTick = null
try {
	while (tick < report.orderTick + 150) {
		await waitForSnapshot(runtime, { minimumTick: tick + 1, timeoutMs: 30_000, onSnapshot: observe })
		const status = curtain()
		if (report.restartTick === null && status && !status.ready && status.remainingTicks > 0) {
			report.restartTick = tick
			report.statusAfter = status
		}
	}
} catch (error) {
	report.failure = error.message
}
report.lastTick = tick
report.hostStatus = runtime.program.HostStatus()
writeFileSync(join(out, 'engine-report.json'), JSON.stringify(report, null, 2) + '\n')

assert.match(report.order, /^ok:/, `bridge refused the player-actor order: ${report.order}`)
assert.equal(report.failure, null, `simulation stopped after the Iron Curtain order (tick ${report.orderTick} -> ${report.lastTick}, host ${report.hostStatus}): ${report.failure}`)
assert.ok(report.restartTick !== null, `Iron Curtain charge never restarted, so the activation never ran (last ${JSON.stringify(curtain())})`)

// Chronoshift: source footprint as ExtraLocation, destination as the target cell.
const chrono = () => runtime.bridge.getSupportPowers()?.powers?.find(p => p.key === 'Chronoshift')
const chronoDeadline = performance.now() + 60_000
while (!chrono()?.ready) {
	assert.ok(performance.now() < chronoDeadline, `Chronoshift never became ready: ${JSON.stringify(runtime.bridge.getSupportPowers())}`)
	await waitForSnapshot(runtime, { minimumTick: tick + 5, onSnapshot: observe })
}
assert.equal(chrono().needsSource, true, 'the status must say Chronoshift takes a source cell')
const before = findActor('1tnk')
assert.ok(before, 'the Chronoshift fixture tank is missing')
report.chronoshift = { before, order: runtime.bridge.issueOrder({
	orderString: 'Chronoshift', subjectIds: new Uint32Array(0), subjectCount: 0,
	targetCellX: CHRONO_DEST.x, targetCellY: CHRONO_DEST.y, extraData: 0xFFFFFFFF,
	extraCellX: Math.floor(before.x), extraCellY: Math.floor(before.y),
}), orderTick: tick, after: null }
await waitForSnapshot(runtime, { minimumTick: tick + 40, timeoutMs: 30_000, onSnapshot: observe })
report.chronoshift.after = findActor('1tnk')
const moved = report.chronoshift.after && Math.hypot(report.chronoshift.after.x - CHRONO_DEST.x - .5, report.chronoshift.after.y - CHRONO_DEST.y - .5) < 2.5
writeFileSync(join(out, 'engine-report.json'), JSON.stringify(report, null, 2) + '\n')
assert.match(report.chronoshift.order, /^ok:/, `bridge refused the Chronoshift order: ${report.chronoshift.order}`)
assert.ok(moved, `Chronoshift did not move the tank from ${JSON.stringify(before)} to ${JSON.stringify(CHRONO_DEST)}: now ${JSON.stringify(report.chronoshift.after)}`)

// Bot nuke: the strike is the drop in the local player's actor count; the sim must keep ticking.
const localCount = () => actorIdsOwnedBy(header, renderPlayerIndex(header)).length
report.nuke = { baseActors: localCount(), strikeTick: null, actorsAfter: null, lastTick: 0, failure: null }
try {
	while (tick < NUKE_DEADLINE_TICKS && report.nuke.strikeTick === null) {
		await waitForSnapshot(runtime, { minimumTick: tick + 5, timeoutMs: 30_000, onSnapshot: observe })
		if (localCount() <= report.nuke.baseActors - 2) report.nuke.strikeTick = tick
	}
	if (report.nuke.strikeTick !== null)
		await waitForSnapshot(runtime, { minimumTick: report.nuke.strikeTick + 50, timeoutMs: 30_000, onSnapshot: observe })
} catch (error) {
	report.nuke.failure = error.message
}
report.nuke.actorsAfter = localCount()
report.nuke.lastTick = tick
report.nuke.atomicImpactTick = atomicImpactTick
report.hostStatus = runtime.program.HostStatus()
writeFileSync(join(out, 'engine-report.json'), JSON.stringify(report, null, 2) + '\n')
assert.equal(report.nuke.failure, null, `simulation stopped around the bot's nuke (tick ${report.nuke.lastTick}, host ${report.hostStatus}): ${report.nuke.failure}`)
assert.ok(report.nuke.strikeTick !== null, `the bot never struck the local base with its nuke by tick ${NUKE_DEADLINE_TICKS} (${report.nuke.baseActors} -> ${report.nuke.actorsAfter} local actors)`)
assert.ok(atomicImpactTick !== null, 'the Atomic detonation never reached the presentation as an impact event naming its weapon')
console.log('SUPPORT_POWER_GATE_PASS', JSON.stringify({ key: report.statusBefore.key, orderTick: report.orderTick, restartTick: report.restartTick, chronoshift: report.chronoshift, nuke: report.nuke }))
process.exit(0)
