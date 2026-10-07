#!/usr/bin/env node
// STEELSEED — tools/foggate
// The published shroud grid must agree with the actors the same snapshot delivers.
//
// OpenRA has two vision switches, and they are not the same switch. "Explored Map" says
// whether the map starts uncovered; "Fog of War" says whether uncovered ground you cannot
// currently see is greyed out. Shroud.IsVisible short-circuits to "every cell in the map" the
// moment fog is off — there is no fog to hide anything — but ACTOR visibility does not follow
// it there: HiddenUnderFog.IsVisibleInner falls back to EXPLORATION when fog is disabled.
//
// The emitter built its grid from IsVisible alone, so a fog-off match published a grid saying
// the whole map was in plain sight while the very same snapshot withheld every enemy actor
// standing on it. On screen that is a fully lit world with no opponent anywhere in it, and it
// was reported exactly that way: "the fog of war is off and I still cannot see the enemy."
//
// So this gate checks the pair, not either half:
//   1. Fog on, unexplored map: unchanged three-tier grid, no opponent actors.
//   2. Fog off, unexplored map: the grid must NOT claim a revealed map, and the uncovered
//      area must be exactly the ground the fog-on run had explored or seen.
//   3. Fog off, explored map: the grid says everything is seen AND the opponent is delivered.
//   4. Fog on, explored map: remembered structures cross as frozen actors, none live.
//   5. Across every case: a grid claiming total visibility must come with opponent actors.
//   6. Across every case: an opponent's economy is withheld (cash, resources and power 0, no
//      production queue in either section), while the local player's is present (vfx.md S07).
//
//   node tools/foggate.mjs [--tick=300] [--bundle=<AppBundle>]

import { spawnSync } from 'node:child_process'
import { bootRuntime, configFor, renderPlayerIndex, shroudStats, waitForSnapshot } from './runtime-fixture.mjs'
import { fail } from './gate-lib.mjs'

const TOOL = 'foggate'
const arg = (name, fallback) => {
	const found = process.argv.find(value => value.startsWith(`--${name}=`))
	return found ? found.slice(name.length + 3) : fallback
}
const tick = Number(arg('tick', '300'))
const bundle = arg('bundle', null)
const testCase = arg('case', null)

// Each case needs a world of its own and the .NET runtime is a per-process singleton, so the
// gate runs itself once per lobby setting and reads back one line of measurements.
if (testCase !== null) {
	const [fog, explored] = testCase.split(':')
	console.log(`FOGRESULT ${JSON.stringify(await measure(fog, explored))}`)
	process.exit(0)
}

const cases = ['True:False', 'False:False', 'False:True', 'True:True']
const results = {}
for (const name of cases) {
	const child = spawnSync(process.execPath, [import.meta.filename, `--case=${name}`, `--tick=${tick}`,
		...(bundle ? [`--bundle=${bundle}`] : [])], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
	if (child.status !== 0) fail(TOOL, `case ${name} exited ${child.status}:\n${child.stdout}\n${child.stderr}`)
	const line = child.stdout.split('\n').find(value => value.startsWith('FOGRESULT '))
	if (!line) fail(TOOL, `case ${name} returned no measurement:\n${child.stdout}`)
	results[name] = JSON.parse(line.slice('FOGRESULT '.length))
}

const fogOn = results['True:False']
const fogOff = results['False:False']
const revealed = results['False:True']
const remembered = results['True:True']

// --- 5. the rule that was broken, stated once for every case --------------------------------
// A grid with no unexplored and no explored-only cells is telling the player they can see the
// entire map. If the same snapshot carries no opponent, the player is looking at a lie.
for (const [name, result] of Object.entries(results))
	if (result.shroud.unexplored === 0 && result.shroud.explored === 0 && result.opponentActors === 0)
		fail(TOOL, `case ${name} publishes a fully visible ${result.cells}-cell grid but no opponent actor: ` +
			`the map is lit and the enemy is missing from it (${JSON.stringify(result.shroud)})`)

// --- 6. an opponent's economy never crosses, whatever the vision settings -------------------
for (const [name, result] of Object.entries(results)) {
	for (const bot of result.economy.opponents)
		if (bot.cash !== 0 || bot.resources !== 0 || bot.powerSupplied !== 0 || bot.powerDrawn !== 0 || bot.queues !== 0 || bot.productionQueues !== 0)
			fail(TOOL, `case ${name}: an opponent's economy crossed to this client: ${JSON.stringify(bot)}`)
	if (result.economy.local.cash + result.economy.local.resources <= 0 || result.economy.local.productionQueues <= 0)
		fail(TOOL, `case ${name}: the local player's own economy is missing: ${JSON.stringify(result.economy.local)}`)
}

// --- 1. fog on, unexplored map --------------------------------------------------------------
if (fogOn.shroud.unexplored <= 0 || fogOn.shroud.visible <= 0)
	fail(TOOL, `fog on: expected a partly uncovered map, got ${JSON.stringify(fogOn.shroud)}`)
if (fogOn.opponentActors !== 0)
	fail(TOOL, `fog on: ${fogOn.opponentActors} opponent actors crossed from unexplored ground`)

// --- 2. fog off, unexplored map -------------------------------------------------------------
if (fogOff.shroud.unexplored <= 0)
	fail(TOOL, `fog off on an unexplored map reports ${fogOff.shroud.unexplored} unexplored cells of ` +
		`${fogOff.cells}: the grid claims a revealed map the simulation has not revealed, so every ` +
		'actor standing in the shroud is still withheld and the player sees a lit, empty world')
if (fogOff.shroud.explored !== 0)
	fail(TOOL, `fog off still publishes ${fogOff.shroud.explored} fog-tier cells; with no fog, ` +
		'uncovered ground is seen, not remembered')
if (fogOff.shroud.visible !== fogOn.shroud.visible + fogOn.shroud.explored)
	fail(TOOL, `fog off uncovers ${fogOff.shroud.visible} cells but the same seed explored ` +
		`${fogOn.shroud.visible + fogOn.shroud.explored} with fog on: the fog-off grid must be the ` +
		'exploration layer promoted, not a different set of cells')

// --- 3. fog off, explored map ---------------------------------------------------------------
if (revealed.shroud.visible !== revealed.cells || revealed.shroud.unexplored !== 0)
	fail(TOOL, `full reveal published ${JSON.stringify(revealed.shroud)} of ${revealed.cells} cells`)
if (revealed.opponentActors <= 0)
	fail(TOOL, 'full reveal delivered no opponent actors; nothing to see on the map or the minimap')

// --- 4. fog on, explored map ----------------------------------------------------------------
if (remembered.shroud.unexplored !== 0 || remembered.shroud.explored <= 0)
	fail(TOOL, `explored map under fog published ${JSON.stringify(remembered.shroud)}`)
if (remembered.frozen <= 0)
	fail(TOOL, 'explored map under fog published no remembered structures')
if (remembered.opponentActors !== 0)
	fail(TOOL, `${remembered.opponentActors} live opponent actors crossed under fog`)

console.log(`${TOOL}: PASS — at tick ${tick}: fog on ${JSON.stringify(fogOn.shroud)} with ` +
	`${fogOn.opponentActors} opponents; fog off uncovers exactly the same ` +
	`${fogOff.shroud.visible} cells the fog-on run had reached, of ${fogOff.cells}, and still ` +
	`withholds the ${fogOff.opponentActors === 0 ? 'unseen' : fogOff.opponentActors} opponent; ` +
	`full reveal shows all ${revealed.cells} cells with ${revealed.opponentActors} opponent actors; ` +
	`explored map under fog remembers ${remembered.frozen} structures with ` +
	`${remembered.opponentActors} live opponents`)

async function measure(fog, explored) {
	const runtime = await bootRuntime(bundle ? { bundleRoot: bundle } : {})
	const catalog = runtime.bridge.getSkirmishCatalog()
	const map = catalog.maps.find(candidate => candidate.title === 'Marigold Town') ?? catalog.maps[0]
	const config = configFor(catalog, map, { randomSeed: 104729, withBot: true })
	config.options.fog = fog
	config.options.explored = explored
	const started = runtime.bridge.startSkirmish(config)
	if (started.status !== 'loading') fail(TOOL, `start returned ${started.status}/${started.code}`)
	const { header } = await waitForSnapshot(runtime, { minimumTick: tick, timeoutMs: 240000 })
	const local = renderPlayerIndex(header)
	const opponents = new Set(botIndexes(header))
	let opponentActors = 0
	for (const owner of actorOwners(header)) if (owner !== local && opponents.has(owner)) opponentActors++
	const frozenSection = header.sections.get(10)
	return {
		fog, explored, tick: header.tick, local,
		cells: map.bounds.width * map.bounds.height,
		opponentActors,
		frozen: frozenSection ? header.view.getUint32(frozenSection.offset, true) : 0,
		shroud: shroudStats(header),
		economy: economy(header, local, opponents),
	}
}

/** The players section's cash, resources, power and queue count, and the production queues per player. */
function economy(header, local, opponents) {
	const players = header.sections.get(8), production = header.sections.get(9)
	const v = header.view, rows = []
	if (players) {
		const count = v.getUint32(players.offset, true)
		let o = players.offset + 4
		for (let index = 0; index < count; index++) {
			const queues = v.getUint16(o + 30, true)
			rows.push({ index, cash: v.getUint32(o, true), resources: v.getUint32(o + 4, true), powerSupplied: v.getInt16(o + 8, true),
				powerDrawn: v.getInt16(o + 10, true), queues, productionQueues: 0 })
			o += 36 + queues * 8
		}
	}
	if (production) {
		const count = v.getUint32(production.offset, true)
		let o = production.offset + 4
		for (let q = 0; q < count; q++) {
			const owner = v.getUint8(o), items = v.getUint16(o + 10, true)
			if (rows[owner]) rows[owner].productionQueues++
			o += 12 + items * 12
		}
	}
	return { local: rows[local] ?? { cash: 0, resources: 0, productionQueues: 0 }, opponents: rows.filter(row => opponents.has(row.index)) }
}

function actorOwners(header) {
	const section = header.sections.get(3)
	if (!section) return []
	const count = header.view.getUint32(section.offset, true)
	const owners = (section.offset + 8 + count * 28 + 3) & ~3
	const result = []
	for (let index = 0; index < count; index++) result.push(header.view.getUint8(owners + index))
	return result
}

function botIndexes(header) {
	const section = header.sections.get(8)
	if (!section) return []
	const count = header.view.getUint32(section.offset, true)
	let offset = section.offset + 4
	const bots = []
	for (let index = 0; index < count; index++) {
		if ((header.view.getUint8(offset + 21) & 4) !== 0) bots.push(index)
		offset += 36 + header.view.getUint16(offset + 30, true) * 8
	}
	return bots
}
