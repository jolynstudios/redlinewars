#!/usr/bin/env node
// STEELSEED — every spy infiltration a player can make (vfx.md Epic 3, Spy: "refinery/silo cash,
// radar exploration, production-structure support power, science/superweapon reset and local
// fake/campaign variants. Display only the actual consequence").
//
// Real shipping host and stock OpenRA traits, the map unexplored, through the bridge calls the page makes
// (queryContextOrder for the cursor, issueContextOrder for the click). Only the in-memory fixture
// map changes: an enemy of every infiltratable type stands with one of our spies beside it, and
// the map's rules block lets us see the Iron Curtain's and the Chronosphere's timers as we already
// see the silo's and the tech centre's (DisplayTimerRelationships), so their reset is observable.
// PASS requires, for each target, that the cursor offers Infiltrate, the spy enters (and is spent),
// and OpenRA's own consequence reaches what the page reads:
//   InfiltrateForSupportPower       spen, syrd: the Sonar Pulse joins our powers. weap: our next
//                                   vehicle arrives ranked (vehicles.upgraded); barr, tent: our
//                                   next soldier (barracks.upgraded); afld, afld.ukraine, hpad:
//                                   our next aircraft (aircraft.upgraded).
//   InfiltrateForSupportPowerReset  atek, iron, mslo, pdox: the enemy's timer jumps back to full.
//   InfiltrateForExploration        dome: the enemy's explored ground becomes ours.
//   InfiltrateForDecoration         the nine fakes: named in the status's `revealed`, which the
//                                   HUD tags FAKE; never before the spy is inside.
// The verdicts are also written to docs/vfx/scenario-evidence.json, one row per actor and trait.
//
//   node tools/spyinfiltrationgate.mjs [--bundle=<AppBundle>]
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../../web/node_modules/esbuild/lib/main.js'
import { bootVfsRuntime } from './runtime-vfs-fixture.mjs'
import { configFor, shroudStats, waitForSnapshot } from './runtime-fixture.mjs'

const root = resolve(import.meta.dirname, '../../..')
const bundled = await build({ stdin: { contents: "export {SnapshotDecoder} from './src/core/snapshot'", resolveDir: join(root, 'web') }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' })
const decoderModule = { exports: {} }; new Function('module', 'exports', bundled.outputFiles[0].text)(decoderModule, decoderModule.exports)
const decoder = new decoderModule.exports.SnapshotDecoder()

const GRANTS = { spen: 'sonar', syrd: 'sonar', weap: 'vehicle', barr: 'soldier', tent: 'soldier', afld: 'aircraft', 'afld.ukraine': 'aircraft', hpad: 'aircraft' }
const RESETS = ['atek', 'iron', 'mslo', 'pdox']
const FAKES = ['atef', 'domf', 'fapw', 'fpwr', 'mslf', 'pdof', 'syrf', 'tenf', 'weaf']
const TARGETS = [...Object.keys(GRANTS), ...RESETS, 'dome', ...FAKES]
// A grid of lots, one target each, a spy two cells west of it.
const lot = i => ({ x: 34 + (i % 6) * 12, y: 6 + Math.floor(i / 6) * 11 })
const POND = { x0: 16, x1: 24, y0: 44, y1: 51 }

const bundleArg = process.argv.find(a => a.startsWith('--bundle='))?.slice('--bundle='.length)
const runtime = await bootVfsRuntime(fs => {
	const dir = '/openra/engine/mods/ra/maps/doubles', file = dir + '/map.yaml'
	const text = fs.readFile(file, { encoding: 'utf8' })
	const actors = [
		['Spawn0', 'mpspawn', 'Neutral', 6, 6], ['Spawn1', 'mpspawn', 'Neutral', 106, 50],
		['Spawn2', 'mpspawn', 'Neutral', 6, 50], ['Spawn3', 'mpspawn', 'Neutral', 106, 6],
		['OwnYard', 'fact', 'Multi0', 6, 30], ['OwnPower', 'apwr', 'Multi0', 6, 36], ['OwnPowerB', 'apwr', 'Multi0', 10, 36],
		['OwnFactory', 'weap', 'Multi0', 12, 26], ['OwnBarracks', 'tent', 'Multi0', 12, 32], ['OwnAirfield', 'afld', 'Multi0', 12, 40],
		['EnemyYard', 'fact', 'Multi1', 104, 48],
		// Power for the enemy's superweapons, whose timers only run while powered.
		['EnemyPowerA', 'apwr', 'Multi1', 96, 48], ['EnemyPowerB', 'apwr', 'Multi1', 90, 48], ['EnemyPowerC', 'apwr', 'Multi1', 84, 48],
		['EnemyPowerD', 'apwr', 'Multi1', 78, 48], ['EnemyPowerE', 'apwr', 'Multi1', 72, 48], ['EnemyPowerF', 'apwr', 'Multi1', 66, 48],
	]
	TARGETS.forEach((type, i) => {
		const at = lot(i)
		actors.push([`Target${i}`, type, 'Multi1', at.x, at.y], [`Spy${i}`, 'spy', 'Multi0', at.x - 3, at.y + 1])
	})
	const rules = '\nRules:\n'
		+ '\tIRON:\n\t\tGrantExternalConditionPower@IRONCURTAIN:\n\t\t\tDisplayTimerRelationships: Ally, Neutral, Enemy\n'
		+ '\tPDOX:\n\t\tChronoshiftPower@chronoshift:\n\t\t\tDisplayTimerRelationships: Ally, Neutral, Enemy\n'
	fs.writeFile(file, text.split('\nActors:\n')[0] + '\nActors:\n'
		+ actors.map(([id, type, owner, x, y]) => `\t${id}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${x},${y}\n`).join('') + rules)
	const width = 112, height = 54, n = width * height, terrain = new Uint8Array(5 + n * 5), view = new DataView(terrain.buffer)
	terrain[0] = 1; view.setUint16(1, width, true); view.setUint16(3, height, true)
	for (let i = 0; i < n; i++) view.setUint16(5 + i * 3, 255, true)
	// A pond (template 1, water) for the granted Sonar Pulse, which only targets water.
	// map.bin stores tiles column by column (OpenRA Map: x outer, y inner).
	for (let y = POND.y0; y <= POND.y1; y++) for (let x = POND.x0; x <= POND.x1; x++) view.setUint16(5 + (x * height + y) * 3, 1, true)
	fs.writeFile(dir + '/map.bin', terrain)
}, ...(bundleArg ? [resolve(bundleArg)] : []))

const catalog = runtime.bridge.getSkirmishCatalog(), map = catalog.maps.find(m => m.title === 'Doubles')
assert.ok(map, 'Doubles map missing from the skirmish catalog')
const config = configFor(catalog, map, { withBot: true })
// Fog off, map unexplored: explored ground stays in sight (so a fake stays seen after its spy is
// inside, as OpenRA draws the decoration only on a structure in view) and the radar dome still
// has unexplored ground to give.
config.options.explored = 'False'; config.options.fog = 'False'
if (map.options.some(o => o.id === 'cheats')) config.options.cheats = 'True'
config.local.faction = 'england'; config.slots[0].faction = 'england'; config.slots[1].faction = 'russia'
assert.equal(runtime.bridge.startSkirmish(config).status, 'loading')

let snap = null, header = null, names = null
const observe = (h, bytes) => { header = h; snap = decoder.decode(bytes); names ??= runtime.bridge.snapshotTypeTable().split('\n') }
const until = async (tick) => { while (!snap || snap.tick < tick) await waitForSnapshot(runtime, { minimumTick: (snap?.tick ?? 0) + 1, timeoutMs: 30_000, onSnapshot: observe }) }
await until(10)
const me = snap.world.renderPlayer
const rows = () => { const a = snap.actors, out = []; for (let i = 0; i < a.count; i++) out.push({ id: a.id[i], type: names[a.typeId[i]], owner: a.owner[i], x: a.posX[i] / 1024, y: a.posY[i] / 1024, vet: a.veterancy[i] }); return out }
const near = (type, x, y, owner) => rows().find(r => r.type === type && (owner === undefined || r.owner === owner) && Math.hypot(r.x - x, r.y - y) < 3.5) ?? null
const supportStatus = () => runtime.bridge.getSupportPowers()
const powers = () => supportStatus()?.powers ?? []
const explored = () => { const s = shroudStats(header); return s ? s.explored + s.visible : 0 }
const intent = (subject, target) => ({ subjectIds: Uint32Array.of(subject.id), subjectCount: 1,
	targetActorId: target.id, targetCellX: Math.floor(target.x), targetCellY: Math.floor(target.y), targetFrozen: false, modifiers: 0 })
const issue = order => runtime.bridge.issueOrder({ subjectIds: new Uint32Array(0), subjectCount: 0, ...order })
// Fast build, all tech, power and cash for our production baselines. Not DevAll: it also
// explores the whole map, which would leave the radar dome nothing to show.
for (const dev of ['DevEnableTech', 'DevFastBuild', 'DevFastCharge', 'DevUnlimitedPower', 'DevGiveCash'])
	assert.match(issue({ orderString: dev }), /^ok/, `the fixture needs ${dev}`)
// Every spy and target, found before the bot's own barracks can train anything to meet them.
const targets = TARGETS.map((type, i) => {
	const at = lot(i)
	const target = near(type, at.x + 1, at.y + 1, undefined) ?? near(type, at.x, at.y)
	const spy = near('spy', at.x - 2.5, at.y + 1.5, me)
	return { type, target, spy }
})
for (const t of targets) assert.ok(t.target && t.spy, `fixture ${t.type}: target ${JSON.stringify(t.target)} spy ${JSON.stringify(t.spy)}`)

// Our production before any infiltration: the baseline rank of a new vehicle, soldier, aircraft.
const produce = async type => {
	const before = new Set(rows().filter(r => r.type === type && r.owner === me).map(r => r.id))
	assert.match(issue({ orderString: 'StartProduction', targetString: type, extraData: 1, queued: true }), /^ok/, `StartProduction ${type}`)
	const deadline = snap.tick + 1500
	while (snap.tick < deadline) {
		await until(snap.tick + 5)
		const made = rows().find(r => r.type === type && r.owner === me && !before.has(r.id))
		if (made) return made
	}
	throw new Error(`no ${type} produced`)
}
const baseline = { vehicle: (await produce('1tnk')).vet, soldier: (await produce('e1')).vet, aircraft: (await produce('yak')).vet }

// The enemy's superweapon timers have run since the start; a reset must be a visible jump.
await until(Math.max(snap.tick, 160))
const timerOf = type => (supportStatus()?.timers ?? []).find(t => !t.allied && new RegExp(type === 'atek' ? 'gps' : type === 'mslo' ? 'nuke' : type === 'iron' ? 'curtain|iron|external' : 'chrono', 'i').test(`${t.key} ${t.title}`)) ?? null
const report = {}
const before = { powers: powers().map(p => p.key), explored: explored(), revealed: supportStatus()?.revealed ?? [], timers: Object.fromEntries(RESETS.map(r => [r, timerOf(r)])) }
for (const r of RESETS) assert.ok(before.timers[r] && before.timers[r].remainingTicks < before.timers[r].totalTicks - 100, `the enemy ${r} timer must be public and charging: ${JSON.stringify(before.timers[r])}`)
for (const f of targets.filter(t => FAKES.includes(t.type))) assert.ok(!before.revealed.includes(f.target.id), `${f.type} revealed before any spy went in`)

// The cursor, then the click, for every spy.
for (const t of targets) {
	t.preview = runtime.bridge.queryContextOrder(intent(t.spy, t.target))
	t.order = runtime.bridge.issueContextOrder(intent(t.spy, t.target))
}
const entered = () => targets.every(t => t.enteredTick !== undefined)
const deadline = snap.tick + 600
while (snap.tick < deadline && !entered()) {
	await until(snap.tick + 2)
	const alive = new Set(rows().map(r => r.id))
	for (const t of targets) if (t.enteredTick === undefined && !alive.has(t.spy.id)) {
		t.enteredTick = snap.tick
		if (RESETS.includes(t.type)) t.timerAfter = timerOf(t.type)
	}
}
await until(snap.tick + 10)
for (const t of targets) if (RESETS.includes(t.type) && !t.timerAfter) t.timerAfter = timerOf(t.type)
const after = { powers: powers().map(p => p.key), explored: explored(), revealed: supportStatus()?.revealed ?? [] }
const ranked = { vehicle: (await produce('1tnk')).vet, soldier: (await produce('e1')).vet, aircraft: (await produce('yak')).vet }

// Verdicts, per target.
const date = new Date().toISOString().slice(0, 10), evidence = {}
const failures = []
for (const t of targets) {
	const line = []
	if (t.preview?.order !== 'Infiltrate') failures.push(`${t.type}: the cursor offered ${JSON.stringify(t.preview?.order)}`)
	if (!/^ok:/.test(t.order ?? '')) failures.push(`${t.type}: the click was refused (${t.order})`)
	if (t.enteredTick === undefined) { failures.push(`${t.type}: the spy never entered`); continue }
	line.push(`the cursor offered Infiltrate, the spy entered at tick ${t.enteredTick} and was spent`)
	let trait
	if (GRANTS[t.type]) {
		trait = 'InfiltrateForSupportPower'
		const grant = GRANTS[t.type]
		if (grant === 'sonar') {
			const sonar = after.powers.find(k => !before.powers.includes(k) && /sonar|spawnactor/i.test(k))
			if (!sonar) failures.push(`${t.type}: no sonar pulse joined our powers (${after.powers.join(', ')})`)
			line.push(`the Sonar Pulse joined our support powers (${sonar})`)
		} else {
			if (!(ranked[grant] > baseline[grant])) failures.push(`${t.type}: our next ${grant} arrived at rank ${ranked[grant]} (before ${baseline[grant]})`)
			line.push(`our next ${grant} arrived ranked (${baseline[grant]} -> ${ranked[grant]}: ${grant === 'vehicle' ? 'vehicles' : grant === 'soldier' ? 'barracks' : 'aircraft'}.upgraded)`)
		}
	} else if (RESETS.includes(t.type)) {
		trait = 'InfiltrateForSupportPowerReset'
		const b = before.timers[t.type], a = t.timerAfter
		if (!a || !(a.remainingTicks > b.remainingTicks + 150)) failures.push(`${t.type}: the enemy timer did not reset (${JSON.stringify(b)} -> ${JSON.stringify(a)})`)
		else line.push(`the enemy's ${a.title ?? a.key} timer went back from ${b.remainingTicks} to ${a.remainingTicks} of ${a.totalTicks} ticks (the public timers panel reads it)`)
	} else if (t.type === 'dome') {
		trait = 'InfiltrateForExploration'
		if (!(after.explored > before.explored + 200)) failures.push(`dome: our explored ground did not grow (${before.explored} -> ${after.explored} cells)`)
		line.push(`our explored ground grew from ${before.explored} to ${after.explored} cells: the enemy's exploration became ours`)
	} else {
		trait = 'InfiltrateForDecoration'
		if (!after.revealed.includes(t.target.id)) failures.push(`${t.type}: not named in the status's revealed (${after.revealed.join(',')})`)
		line.push('named in the support-power status as revealed, so the HUD tags it FAKE for our side only')
	}
	evidence[`${t.type}:${trait}`] = `S15 spyinfiltrationgate ${date}: ${line.join('; ')}`
	report[t.type] = line.join('; ')
}
// The granted Sonar Pulse, fired on the pond: its charge restarting is OpenRA's proof it ran.
{
	const sonar = () => powers().find(p => /SpawnActorPower/.test(p.key))
	const until2 = snap.tick + 1200
	while (!sonar()?.ready && snap.tick < until2) await until(snap.tick + 5)
	const ready = sonar()
	if (!ready?.ready) failures.push(`sonar: the granted Sonar Pulse never charged (${JSON.stringify(ready)})`)
	else {
		const order = issue({ orderString: ready.key, targetCellX: POND.x0 + 4, targetCellY: POND.y0 + 3 })
		const fired = snap.tick
		let restarted = null
		while (restarted === null && snap.tick < fired + 60) { await until(snap.tick + 1); const now = sonar(); if (now && !now.ready) restarted = snap.tick }
		if (!/^ok/.test(order) || restarted === null) failures.push(`sonar: fired (${order}) but the charge never restarted`)
		else evidence['powerproxy.sonarpulse:SpawnActorPower'] = `S15 spyinfiltrationgate ${date}: the Sonar Pulse a spy won in the enemy sub pen, fired on open water (${ready.key}, ${String(order).slice(0, 20)}): its charge restarted at tick ${restarted}, OpenRA's proof it spawned the pulse (LifeTime ${ready.effectTicks} ticks, drawn as rings on the water)`
	}
}
console.log(JSON.stringify({ baseline, ranked, before: { explored: before.explored, powers: before.powers }, after: { explored: after.explored, powers: after.powers, revealed: after.revealed.length } }))
for (const [type, line] of Object.entries(report)) console.log(`  ${type}: ${line}`)
assert.deepEqual(failures, [], 'infiltration verdicts')

// The verdicts join the scenario evidence the census reads (the same lock as vfxscenario).
const EVIDENCE = join(root, 'docs/vfx/scenario-evidence.json'), lock = `${EVIDENCE}.lock`
for (let tries = 0; ; tries++) { try { mkdirSync(lock); break } catch (e) { if (e.code !== 'EEXIST') throw e; if (tries > 400) rmSync(lock, { recursive: true, force: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25) } }
try {
	const file = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) : { schemaVersion: 1, weapons: {}, actions: {} }
	file.actions = Object.fromEntries(Object.entries({ ...(file.actions ?? {}), ...evidence }).sort(([a], [b]) => a < b ? -1 : 1))
	writeFileSync(EVIDENCE, JSON.stringify(file, null, '\t') + '\n')
} finally { rmSync(lock, { recursive: true, force: true }) }
console.log(`spyinfiltrationgate: PASS — ${targets.length} infiltrations, each with OpenRA's consequence; ${Object.keys(evidence).length} evidence rows`)
process.exit(0)
