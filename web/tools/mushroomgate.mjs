#!/usr/bin/env node
// STEELSEED — tools/mushroomgate
//
// Does a destroyed BUILDING actually throw a multi-layered mushroom cloud, or just a bigger puff?
//
// A particle counter cannot answer that. The effect this replaces — `smoke` + `fire` + `debris`,
// all at t = 0, all at the actor's centre — emits 38 particles, and a naive "did particles reach
// the pool" assertion is green for both. What separates a mushroom from a puff is entirely in
// WHEN and WHERE each part arrives, so that is what this measures:
//
//   * the cap begins after the stem has been climbing for a second, and after the fireball
//     has finished — a cap that arrives with the stem is a smudge;
//   * the cap sits above the stem and spreads wider than it, and ROLLS OVER: its last
//     emissions are lower and further out than its first;
//   * the skirt goes outward while staying low, which is the opposite growth to the stem;
//   * the smoulder outlives everything and lands on the AUTHORED d5 anchors;
//   * the whole cloud is sized from the building's own bounds, so a construction yard's is
//     taller and wider than a war factory's, which is taller and wider than a pillbox's;
//   * and the budget is bounded, because the pool is shared with every weapon on the map.
//
// THE ASSERTIONS PROVE THEY CAN FAIL, ON EVERY RUN. `VISUAL-QUALITY-PLAN.md` records a check
// this project once shipped that was arithmetically incapable of going red. So the same suite
// that judges the real cloud is re-run against four deliberately broken records — including the
// exact puff this work replaces — and the gate fails if any of those four comes back green.
//
// Then it looks at the frame, because a claim about a schedule is not a claim about a picture.
// A real composed match on a private port, the MCV deployed into a construction yard, one
// authoritative destruction injected, and five screenshots down the cloud's life. The pixel
// assertion is the mushroom read as a picture: the changed region's centroid RISES up the
// screen between the fireball and the cap, and its horizontal spread at the cap is wider than
// at the stem.
//
// Usage:
//   node tools/mushroomgate.mjs [--port=8474] [--no-visual]
//     [--falsify=flat|puff|no-cap|no-rollover]

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'mushroomgate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = (name, fallback = null) => {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : fallback
}
const noVisual = process.argv.includes('--no-visual')
const port = Number(arg('port', '8474'))
const falsify = arg('falsify')
const FALSIFICATIONS = ['flat', 'puff', 'no-cap', 'no-rollover']
if (falsify !== null && !FALSIFICATIONS.includes(falsify)) {
	console.error(`${TOOL}: unknown --falsify=${falsify}; expected one of ${FALSIFICATIONS.join('|')}`)
	process.exit(2)
}
if (port === 8321) {
	console.error(`${TOOL}: 8321 is the live game and must never be bound`)
	process.exit(2)
}

const problems = []
const note = m => problems.push(m)

// ---------------------------------------------------------------------------------------
// Fixtures: the REAL forge artefacts, so the roster lookup and the authored anchors are
// exercised rather than mocked. `import.meta.glob` is Vite's and this runs under plain node,
// which is the same shim `damagestategate` and `treeassetsgate` use.
// ---------------------------------------------------------------------------------------
const FORGE = join(WEB, '.forge')
const rosterPath = join(FORGE, 'blender/manifest.json')
if (!existsSync(rosterPath)) {
	console.error(`${TOOL}: no forged roster at ${rosterPath} — run the forge first`)
	process.exit(2)
}
const roster = JSON.parse(readFileSync(rosterPath, 'utf8'))
const authorReports = {}
const damageDir = join(FORGE, 'damage-states')
if (existsSync(damageDir)) {
	for (const actor of readdirSync(damageDir)) {
		const file = join(damageDir, actor, 'states.author.json')
		if (existsSync(file)) authorReports[`../../.forge/damage-states/${actor}/states.author.json`] = JSON.parse(readFileSync(file, 'utf8'))
	}
}

const tmp = mkdtempSync(join(tmpdir(), 'mushroomgate-'))
const entry = join(tmp, 'e.ts')
writeFileSync(entry, `export { MushroomCloud, MUSHROOM_LAYERS, SCHEDULE_PARTICLES } from '${WEB}/src/fx/mushroom-cloud'\n`)
const bundle = join(tmp, 'b.mjs')
await esbuild({
	entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent',
	define: { 'import.meta.glob': '__mushroomGateGlob' },
	banner: { js: 'const __mushroomGateGlob = pattern => pattern.endsWith(\'blender/manifest.json\') ? { roster: globalThis.__mushroomGateRoster } : globalThis.__mushroomGateAuthors;' },
})
globalThis.__mushroomGateRoster = roster
globalThis.__mushroomGateAuthors = authorReports
const { MushroomCloud, MUSHROOM_LAYERS, SCHEDULE_PARTICLES } = await import(bundle)
const L = MUSHROOM_LAYERS

// Preset -> layer, so a recorded spawn can be attributed without the module telling us. The
// stem deliberately shares two presets with other layers, so it is disambiguated by name AND
// by the order the schedule releases them; `layerOf` below resolves that from the record.
const LAYER_NAME = ['flash', 'fireball', 'rubble', 'skirt', 'stem', 'cap', 'ruin']

// ---------------------------------------------------------------------------------------
// Driving one cloud and recording every spawn.
// ---------------------------------------------------------------------------------------
function actorsFixture(entries) {
	return {
		count: entries.length,
		id: Uint32Array.from(entries, e => e.id),
		typeId: Uint32Array.from(entries, e => e.typeId),
		facing: Uint16Array.from(entries, e => e.facing ?? 0),
		// The full snapshot row the module reads: the health byte and the WPos triple. A
		// fixture that carries half a row would crash the module rather than test it.
		posX: Int32Array.from(entries, e => e.posX ?? 0),
		posY: Int32Array.from(entries, e => e.posY ?? 0),
		posZ: Int32Array.from(entries, e => e.posZ ?? 0),
		health: Uint8Array.from(entries, e => e.health ?? 255),
	}
}

/**
 * Run one destruction to completion and return every spawn, in emission order.
 *
 * The clock is stepped at 1/60 s, the frame rate the game runs at, rather than in one jump —
 * a schedule that only works when it is sampled once is not a schedule.
 */
function runCloud({ actor, typeId = 7, id = 0x4321, facing = 0, health = 255, violence = 200, x = 12.5, z = -7.25, eventY = 0.0, ground = 3.5 }) {
	const cloud = new MushroomCloud()
	const records = []
	const sink = { spawn(name, sx, sy, sz, time, seed, scale) { records.push({ name, x: sx, y: sy, z: sz, time, seed, scale }) } }
	const shroud = { unmodelled: false, isVisible() { return true } }
	const terrain = { heightAt() { return ground } }
	const ctx = {
		snapshot: { actors: actorsFixture([{ id, typeId, facing, health }]) },
		prevSnapshot: null,
		actorTypeName(t) { return t === typeId ? actor : '' },
	}
	const started = cloud.start(id, x, eventY, z, violence, 0, ctx, terrain, shroud)
	if (!started) return { started, records, cloud, ground: ground + eventY, x, z }
	for (let frame = 0; frame <= 60 * 7; frame++) cloud.tick(frame / 60, sink, shroud)
	return { started, records, cloud, ground: ground + eventY, x, z }
}

/** Attribute each record to a layer, from the schedule windows the module publishes. */
const window3 = new Float32Array(3)
const WINDOWS = []
for (let layer = 0; layer < L.LAYERS; layer++) {
	MushroomCloud.layerWindow(layer, window3)
	WINDOWS.push({ from: window3[0], to: window3[1], count: window3[2] })
}
/**
 * Split the recorded stream back into its seven layers.
 *
 * Not by asking the module — by rebuilding the schedule from the three numbers each layer
 * publishes (`from`, `to`, `count`) and the 1/60 s clock the caller stepped, then zipping that
 * expectation against what the frame actually received. A cadence is a claim, and this checks
 * it: every emission must arrive in the expected order, within one frame of its expected
 * moment, carrying a preset that layer is allowed to use. The GEOMETRIC assertions that follow
 * take no input from this — they read the positions the module chose.
 */
function attribute(records) {
	const byLayer = LAYER_NAME.map(() => [])
	const orphans = []
	const legal = (layer, name) =>
		layer === L.FLASH ? name === 'blastcore'
		: layer === L.FIREBALL ? name === 'fireball'
		: layer === L.RUBBLE ? name === 'rubble'
		: layer === L.SKIRT ? name === 'dustskirt'
		: layer === L.CAP ? name === 'mushcap'
		: layer === L.RUIN ? name === 'ruinsmoke'
		: name === 'fireball' || name === 'stemfire' || name === 'mushcap'
	// The frame the emitter's cursor crosses each emission boundary, at 60 Hz.
	const frameOf = seconds => Math.max(0, Math.ceil(seconds * 60 - 1e-9)) / 60
	const expected = []
	for (let layer = 0; layer < L.LAYERS; layer++) {
		const { from, to, count } = WINDOWS[layer]
		for (let k = 0; k < count; k++) {
			const due = count > 1 && to > from ? from + ((to - from) * k) / (count - 1) : from
			expected.push({ layer, k, time: frameOf(due) })
		}
	}
	expected.sort((a, b) => a.time - b.time || a.layer - b.layer || a.k - b.k)
	for (let i = 0; i < Math.max(expected.length, records.length); i++) {
		const want = expected[i]
		const got = records[i]
		if (want === undefined || got === undefined) { if (got !== undefined) orphans.push(got); continue }
		if (!legal(want.layer, got.name) || Math.abs(got.time - want.time) > 1 / 60 + 1e-6) { orphans.push(got); continue }
		byLayer[want.layer].push(got)
	}
	byLayer.orphans = orphans
	return byLayer
}

const dist = (r, x, z) => Math.hypot(r.x - x, r.z - z)
const span = a => (a.length === 0 ? null : { min: Math.min(...a), max: Math.max(...a), mean: a.reduce((s, v) => s + v, 0) / a.length })

/**
 * Everything that makes a cloud a mushroom, as assertions over one recorded cloud.
 *
 * Returns the list of failures, so the same function can be pointed at a deliberately broken
 * record and REQUIRED to come back non-empty.
 */
function judge(label, run, dims) {
	const bad = []
	const say = m => bad.push(`${label}: ${m}`)
	if (!run.started) { say('no cloud started'); return bad }
	const layers = attribute(run.records)
	const at = i => layers[i]
	if (layers.orphans.length > 0)
		say(`${layers.orphans.length} emission(s) fall outside every scheduled layer window: ${layers.orphans.slice(0, 6).map(r => `${r.name}@${r.time.toFixed(4)}`).join(' ')}`)
	let empty = false
	for (let layer = 0; layer < L.LAYERS; layer++) {
		if (at(layer).length !== WINDOWS[layer].count)
			say(`layer ${LAYER_NAME[layer]} emitted ${at(layer).length} of its scheduled ${WINDOWS[layer].count}`)
		if (at(layer).length === 0) empty = true
	}
	// A layer that produced nothing at all cannot be measured; the counts above already say so.
	if (empty) return bad

	const times = l => at(l).map(r => r.time)
	const first = l => Math.min(...times(l))
	const last = l => Math.max(...times(l))

	// 1. THE STAGGER. A cloud whose parts arrive together is a puff with more particles in it.
	const distinctTimes = new Set(run.records.map(r => r.time.toFixed(4))).size
	if (distinctTimes < 60) say(`the whole cloud arrives on ${distinctTimes} distinct frames; it is an instant, not an animation`)
	if (!(first(L.CAP) > first(L.STEM) + 0.7))
		say(`the cap opens ${(first(L.CAP) - first(L.STEM)).toFixed(2)} s after the stem; a cap that arrives with its stem is a smudge`)
	if (!(first(L.CAP) > last(L.FIREBALL)))
		say(`the cap opens at ${first(L.CAP).toFixed(2)} s, before the fireball finishes at ${last(L.FIREBALL).toFixed(2)} s`)
	if (!(last(L.SKIRT) < first(L.CAP)))
		say(`the ground skirt is still spreading at ${last(L.SKIRT).toFixed(2)} s when the cap opens at ${first(L.CAP).toFixed(2)} s`)
	if (!(first(L.RUIN) > last(L.CAP) - 0.3))
		say(`the smoulder starts at ${first(L.RUIN).toFixed(2)} s, before the cap has finished at ${last(L.CAP).toFixed(2)} s`)
	if (!(last(L.RUIN) > last(L.CAP) + 2))
		say(`the smoulder ends at ${last(L.RUIN).toFixed(2)} s; a destroyed base has to look fought-over afterwards`)

	// 2. THE SHAPE. The cap is above the stem and wider than it.
	const capY = span(at(L.CAP).map(r => r.y - run.ground))
	const stemY = span(at(L.STEM).map(r => r.y - run.ground))
	const skirtY = span(at(L.SKIRT).map(r => r.y - run.ground))
	const capR = at(L.CAP).map(r => dist(r, run.x, run.z))
	const stemR = span(at(L.STEM).map(r => dist(r, run.x, run.z)))
	const skirtR = span(at(L.SKIRT).map(r => dist(r, run.x, run.z)))
	// Relative, not absolute: a pillbox's whole cloud is 2.3 m tall and an absolute metre of
	// clearance would encode the construction yard this was first looked at.
	if (!(capY.mean > stemY.mean * 1.35))
		say(`the cap's mean height ${capY.mean.toFixed(2)} m is not clear of the stem's ${stemY.mean.toFixed(2)} m`)
	if (!(capY.mean > dims.height * 2))
		say(`the cap sits at ${capY.mean.toFixed(2)} m over a ${dims.height.toFixed(2)} m building; it has to clear its own roof`)
	if (!(Math.max(...capR) > stemR.max * 1.8))
		say(`the cap reaches ${Math.max(...capR).toFixed(2)} m against a stem of ${stemR.max.toFixed(2)} m; that is a column, not a head`)

	// 3. THE ROLLOVER. Late cap emissions are further out AND lower than early ones. Without
	// this the layer is a flat disc, which reads as a lid rather than as a cap.
	const capOrdered = at(L.CAP).slice().sort((a, b) => a.time - b.time)
	const early = capOrdered.slice(0, 8)
	const late = capOrdered.slice(-8)
	const meanY = rs => rs.reduce((s, r) => s + r.y, 0) / rs.length
	const meanR = rs => rs.reduce((s, r) => s + dist(r, run.x, run.z), 0) / rs.length
	if (!(meanR(late) > meanR(early) * 1.8))
		say(`the cap's last ring is ${meanR(late).toFixed(2)} m out against its first at ${meanR(early).toFixed(2)} m; it does not expand`)
	if (!(meanY(late) < meanY(early)))
		say(`the cap's last ring sits at ${meanY(late).toFixed(2)} m, no lower than its first at ${meanY(early).toFixed(2)} m; it does not roll over`)

	// 4. THE SKIRT is the opposite growth: outward while staying down.
	if (!(skirtY.max < dims.height * 0.5))
		say(`the ground skirt climbs to ${skirtY.max.toFixed(2)} m on a ${dims.height.toFixed(2)} m building; it is not hugging the ground`)
	// Past its own wall: the building's footprint radius is half its plan width.
	if (!(skirtR.max > dims.plan * 0.5))
		say(`the ground skirt reaches ${skirtR.max.toFixed(2)} m and never clears the ${(dims.plan / 2).toFixed(2)} m footprint of its own building`)

	// 5. THE COLOUR RAMP. The stem cools as it climbs, and the module has no over-life ramp to
	// do it with, so it must be switching presets by height.
	const stemSorted = at(L.STEM).slice().sort((a, b) => a.y - b.y)
	const stemPresets = new Set(at(L.STEM).map(r => r.name))
	if (stemPresets.size < 3) say(`the stem uses ${stemPresets.size} preset(s); it cannot cool as it climbs`)
	if (stemSorted[0]?.name !== 'fireball') say(`the stem's lowest emission is '${stemSorted[0]?.name}', not the incandescent preset`)
	if (stemSorted[stemSorted.length - 1]?.name !== 'mushcap') say(`the stem's highest emission is '${stemSorted[stemSorted.length - 1]?.name}', not the cooled preset`)

	// 6. THE BUDGET.
	const particles = run.cloud.stats.particles
	if (particles !== SCHEDULE_PARTICLES) say(`emitted ${particles} particles against a declared schedule of ${SCHEDULE_PARTICLES}`)
	if (particles > 200) say(`${particles} particles per building death is too much of a 2048-slot pool shared with combat`)
	return bad
}

// ---------------------------------------------------------------------------------------
// The real clouds.
// ---------------------------------------------------------------------------------------
function dimsOf(actor) {
	const b = roster.assets[actor].bounds
	return { plan: Math.max(b[1][0] - b[0][0], b[1][2] - b[0][2]), height: b[1][1] - b[0][1] }
}
const yardDims = dimsOf('fact')
const factoryDims = dimsOf('weap')
const boxDims = dimsOf('pbox')

const yard = runCloud({ actor: 'fact', typeId: 11, id: 0x1001, facing: 256 })
const factory = runCloud({ actor: 'weap', typeId: 12, id: 0x1002, facing: 700 })
const pillbox = runCloud({ actor: 'pbox', typeId: 13, id: 0x1003 })

problems.push(...judge('fact', yard, yardDims))
problems.push(...judge('weap', factory, factoryDims))
problems.push(...judge('pbox', pillbox, boxDims))

// ---------------------------------------------------------------------------------------
// THE SIZE HIERARCHY, which is a requirement rather than a nicety:
//     nuke  >  construction yard  >  every other building
// ---------------------------------------------------------------------------------------
const reach = run => Math.max(...run.records.map(r => r.y)) - run.ground
const width = run => Math.max(...run.records.map(r => dist(r, run.x, run.z)))

// `Atomic` in engine/openra/mods/ra/weapons/superweapons.yaml stages SpreadDamage warheads at
// 1c0..5c0, so the weapon's own outermost damage ring is 5 render metres of radius. The nuke
// has no 3D visual in this renderer, so this is the ceiling the RULES give rather than a
// picture to sit beside.
const NUKE_OUTER_RADIUS_M = 5.0

const LADDER = ['fact', 'proc', 'weap', 'dome', 'barr', 'powr', 'pbox', 'sam', 'tsla']
const tier = []
for (let i = 0; i < LADDER.length; i++) {
	const actor = LADDER[i]
	if (roster.assets[actor] === undefined) { note(`the roster has no ${actor} to size a cloud from`); continue }
	const b = roster.assets[actor].bounds
	const volume = (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]) * (b[1][2] - b[0][2])
	// Violence is pinned across the ladder: the comparison has to be of BUILDINGS, not of how
	// hard each one happened to be hit.
	const run = runCloud({ actor, typeId: 60 + i, id: 0x3000 + i, violence: 200 })
	if (!run.started) { note(`${actor} is a building and did not start a cloud`); continue }
	tier.push({ actor, volume, reach: reach(run), width: width(run) })
}
const yardTier = tier.find(t => t.actor === 'fact')
const others = tier.filter(t => t.actor !== 'fact')
const biggestOther = others.reduce((a, b) => (b.reach > a.reach ? b : a), others[0])
if (yardTier === undefined) note('no construction yard cloud to rank')
else {
	// "the biggest multi layer explosion ... but still bigger then the other buildings" — and
	// visibly so. 1.35x is the smallest ratio that reads at gameplay zoom; measured it is 1.57.
	if (!(yardTier.reach > biggestOther.reach * 1.35))
		note(`the construction yard reaches ${yardTier.reach.toFixed(2)} m against ${biggestOther.actor} at ${biggestOther.reach.toFixed(2)} m — not visibly the biggest`)
	if (!(yardTier.width > biggestOther.width * 1.25))
		note(`the construction yard spreads ${yardTier.width.toFixed(2)} m against ${biggestOther.actor} at ${biggestOther.width.toFixed(2)} m`)
	// "...but it cannot be larger then a nuke".
	if (!(yardTier.width <= NUKE_OUTER_RADIUS_M * 0.70))
		note(`the construction yard's cloud spreads ${yardTier.width.toFixed(2)} m against the nuke's ${NUKE_OUTER_RADIUS_M} m outer ring; the superweapon stops being one`)
	if (!(yardTier.width >= NUKE_OUTER_RADIUS_M * 0.50))
		note(`the construction yard's cloud spreads only ${yardTier.width.toFixed(2)} m; it is meant to be the largest building explosion in the game`)
}
// Below the yard the order must follow the buildings themselves, monotonically in volume.
const ranked = others.slice().sort((a, b) => b.volume - a.volume)
for (let i = 1; i < ranked.length; i++)
	if (!(ranked[i - 1].reach >= ranked[i].reach - 1e-6))
		note(`${ranked[i].actor} (${ranked[i].volume.toFixed(2)} m3) throws a bigger cloud than ${ranked[i - 1].actor} (${ranked[i - 1].volume.toFixed(2)} m3)`)
// And the compression has to be real: 22x of volume must not become 22x of cloud.
const volumeSpread = Math.max(...tier.map(t => t.volume)) / Math.min(...tier.map(t => t.volume))
const cloudSpread = Math.max(...tier.map(t => t.reach)) / Math.min(...tier.map(t => t.reach))
if (!(cloudSpread < volumeSpread / 3))
	note(`${volumeSpread.toFixed(1)}x of building volume became ${cloudSpread.toFixed(1)}x of cloud; the mapping is not compressive`)
if (!(cloudSpread > 1.8))
	note(`${volumeSpread.toFixed(1)}x of building volume became only ${cloudSpread.toFixed(1)}x of cloud; a tesla coil and a construction yard read the same`)

// NON-BUILDINGS ARE LEFT ALONE. A tank, the largest tree in the roster and a sandbag wall must
// all be refused, so the generic burst still owes them an explosion. The tree matters: its
// footprint is larger than the construction yard's, so this cannot be a size threshold.
for (const [actor, why] of [['1tnk', 'a tank'], ['t01', 'a tree'], ['sbag', 'a sandbag wall'], ['e1', 'a rifleman']]) {
	const refused = runCloud({ actor, typeId: 50 + actor.length, id: 0x2000 + actor.length })
	if (refused.started) note(`${actor} (${why}) started a mushroom cloud`)
}

// THE AUTHORED d5 ANCHORS. Every ladder's Dead rung authors where the smoke actually sits on
// that ruin and why — `powr` puts one on the oil-soaked rubble, one on the transformer bund and
// one at the shell foot. Until now nothing read any of it. If the ruin smoke falls back to the
// centroid, this is the sixth body of authored data in this project with no consumer.
//
// The subject is whichever LADDERED BUILDING the forge currently holds, not a fixed name:
// ladders are authored and re-authored while this runs, and a gate pinned to one actor goes
// red for a reason that has nothing to do with the cloud.
const anchoredActor = LADDER.find(actor => {
	const states = authorReports[`../../.forge/damage-states/${actor}/states.author.json`]
	return Array.isArray(states) && (states.find(s => s.state === 'd5')?.fx ?? []).some(f => f.kind === 'smoulder' || f.kind === 'smoke')
})
if (anchoredActor === undefined) note('no building in the roster carries authored d5 smoulder anchors, so the anchor assertion is vacuous')
else {
	const facingA = 700
	const anchoredRun = runCloud({ actor: anchoredActor, typeId: 90, id: 0x4001, facing: facingA })
	const authored = (authorReports[`../../.forge/damage-states/${anchoredActor}/states.author.json`]
		.find(s => s.state === 'd5').fx ?? []).filter(f => f.kind === 'smoulder' || f.kind === 'smoke')
	const yawA = Math.PI * 0.5 + (facingA / 1024) * Math.PI * 2
	const c = Math.cos(yawA), sn = Math.sin(yawA)
	const wanted = authored.map(a => ({
		x: anchoredRun.x + a.atM[0] * c + a.atM[2] * sn,
		y: anchoredRun.ground + a.atM[1],
		z: anchoredRun.z - a.atM[0] * sn + a.atM[2] * c,
	}))
	const ruin = attribute(anchoredRun.records)[L.RUIN]
	const matched = ruin.filter(r => wanted.some(w => Math.hypot(r.x - w.x, r.y - w.y, r.z - w.z) < 1e-3))
	if (matched.length !== ruin.length)
		note(`${matched.length} of ${ruin.length} ${anchoredActor} ruin emissions sit on an authored d5 anchor; the rest are guessed`)
	// The anchors must actually be OFF-CENTRE, or "it read the file" would be indistinguishable
	// from "it fell back to the centroid".
	if (!(Math.max(...wanted.map(w => Math.hypot(w.x - anchoredRun.x, w.z - anchoredRun.z))) > 0.05))
		note(`${anchoredActor}'s authored anchors are all at the centroid, so matching them proves nothing`)
	if (anchoredRun.cloud.stats.anchored !== 1) note(`${anchoredActor} has an authored d5 ladder and its cloud did not read it`)
	// And an actor with NO ladder must still smoulder, on the fallback.
	if (attribute(pillbox.records)[L.RUIN].length !== WINDOWS[L.RUIN].count)
		note('an actor without an authored ladder lost its smoulder entirely')
}
if (pillbox.cloud.stats.anchored !== 0) note('pbox has no authored ladder, so its cloud must not report an anchor')

// DETERMINISM. Rule 5: no Math.random, and the same replay on two machines is the same cloud.
const replay = runCloud({ actor: 'weap', typeId: 12, id: 0x1002, facing: 700 })
if (JSON.stringify(replay.records) !== JSON.stringify(factory.records)) note('two runs of the same destruction produced different clouds')

// THE POOL BUDGET, at the module's own ceiling. A fifth simultaneous building death is refused
// rather than allowed to evict the rest of the battle out of a shared 2048-slot pool.
{
	const cloud = new MushroomCloud()
	const shroud = { unmodelled: false, isVisible() { return true } }
	const terrain = { heightAt() { return 0 } }
	const entries = []
	for (let i = 0; i < 6; i++) entries.push({ id: 0x9000 + i, typeId: 12, facing: 0 })
	const ctx = { snapshot: { actors: actorsFixture(entries) }, prevSnapshot: null, actorTypeName(t) { return t === 12 ? 'weap' : '' } }
	let ok = 0
	for (const e of entries) if (cloud.start(e.id, 5, 0, 5, 255, 0, ctx, terrain, shroud)) ok++
	if (ok !== L.MAX_CLOUDS) note(`${ok} concurrent clouds started against a ceiling of ${L.MAX_CLOUDS}`)
	if (cloud.stats.refused !== entries.length - L.MAX_CLOUDS) note(`${cloud.stats.refused} refusals recorded, expected ${entries.length - L.MAX_CLOUDS}`)
	const worst = L.MAX_CLOUDS * SCHEDULE_PARTICLES
	if (worst > 700) note(`the worst case is ${worst} of 2048 pool slots, which is more than a third of the battlefield's particles`)
}

// WHAT IS LEFT TO BURN. The same building killed twice: once off full health, once after
// the fight has already taken 85% of it. DESTRUCTION-PLAN §4.1: how much cloud a death
// throws is decided by how much building is LEFT, so the low-burn run must measure strictly
// smaller — and a health byte of 0 is the wire's "unknown", which must resolve to FULL burn,
// never to a cloud of nothing.
{
	const full = runCloud({ actor: 'weap', typeId: 12, id: 0x3101, facing: 700, health: 255 })
	const scraped = runCloud({ actor: 'weap', typeId: 12, id: 0x3101, facing: 700, health: 40 })
	if (!full.started || !scraped.started) note('a burn pair failed to start, so the burn assertion is vacuous')
	else {
		const fullMax = Math.max(...full.records.map(r => r.scale))
		const scrapedMax = Math.max(...scraped.records.map(r => r.scale))
		if (!(scrapedMax < fullMax))
			note(`a building killed at byte 40 threw max particle scale ${scrapedMax.toFixed(3)}, same as full health's ${fullMax.toFixed(3)}; the burn multiplier is not observable`)
		const unknown = runCloud({ actor: 'weap', typeId: 12, id: 0x3102, facing: 700, health: 0 })
		if (!(Math.max(...unknown.records.map(r => r.scale)) >= fullMax - 1e-9))
			note('a health byte of 0 produced a smaller cloud than full health; unknown burn must resolve to 255')
	}
}

// ---------------------------------------------------------------------------------------
// PROOF THE SUITE CAN FAIL. Four broken records, every one of which must go red.
// ---------------------------------------------------------------------------------------
function breakRun(mode, run) {
	const clone = { ...run, records: run.records.map(r => ({ ...r })) }
	if (mode === 'flat') for (const r of clone.records) r.time = 0
	if (mode === 'puff') {
		// Exactly the effect this replaces: three presets, one instant, one point.
		clone.records = [
			{ name: 'smoke', x: run.x, y: run.ground + 0.2, z: run.z, time: 0, seed: 1, scale: 1 },
			{ name: 'fire', x: run.x, y: run.ground + 0.2, z: run.z, time: 0, seed: 1, scale: 1 },
			{ name: 'debris', x: run.x, y: run.ground + 0.2, z: run.z, time: 0, seed: 1, scale: 1 },
		]
	}
	if (mode === 'no-cap') for (const r of clone.records) if (r.name === 'mushcap') r.y = run.ground
	if (mode === 'no-rollover') {
		let top = -Infinity
		for (const r of clone.records) top = Math.max(top, r.y)
		for (const r of clone.records) if (r.name === 'mushcap' && r.y > run.ground + 2) r.y = top
	}
	return clone
}
const selfTests = [
	['flat', 'every layer released in the same instant'],
	['puff', 'the three-preset burst this replaces'],
	['no-cap', 'the cap flattened onto the ground'],
	['no-rollover', 'the cap held at one height instead of rolling over'],
]
for (const [mode, why] of selfTests) {
	const broken = judge(`self-test:${mode}`, breakRun(mode, factory), factoryDims)
	if (broken.length === 0) note(`the suite passed ${why} — an assertion that cannot fail is worse than no assertion`)
}
// The size assertions must not be vacuous either: if two buildings already threw the same
// cloud, "it follows the building" would be proving nothing.
if (!(reach(factory) > reach(pillbox) + 0.5)) note('the size assertion is vacuous: weap and pbox already reach the same height')
if (Object.keys(authorReports).length === 0)
	note('no authored d5 anchors were loaded at all, so the anchor assertion could not have failed')

// The requested falsification runs the real suite against a broken record and REPORTS red.
if (falsify !== null) problems.push(...judge(`--falsify=${falsify}`, breakRun(falsify, factory), factoryDims))

const summary = [
	`${TOOL}: schedule ${SCHEDULE_PARTICLES} particles over ${WINDOWS[L.RUIN].to.toFixed(1)} s in ${L.LAYERS} layers ` +
	`(cap opens ${WINDOWS[L.CAP].from.toFixed(2)} s, ${(WINDOWS[L.CAP].from - WINDOWS[L.STEM].from).toFixed(2)} s after the stem); ` +
	`ceiling ${L.MAX_CLOUDS} clouds = ${L.MAX_CLOUDS * SCHEDULE_PARTICLES}/2048 pool slots`,
	`${TOOL}: tier (volume m3 -> cloud height m / cloud radius m, nuke outer ring ${NUKE_OUTER_RADIUS_M} m): ` +
	tier.map(t => `${t.actor} ${t.volume.toFixed(2)} -> ${t.reach.toFixed(2)}/${t.width.toFixed(2)}`).join('  '),
	`${TOOL}: fact is ${(yardTier.reach / biggestOther.reach).toFixed(2)}x the next building (${biggestOther.actor}) ` +
	`and ${(yardTier.width / NUKE_OUTER_RADIUS_M * 100).toFixed(0)}% of the nuke's outer ring`,
	`${TOOL}: authored d5 anchors read for ${Object.keys(authorReports).length} actor(s); ${anchoredActor ?? 'no'} building smoulders on its own`,
]

// ---------------------------------------------------------------------------------------
// The frame. A schedule is not a picture.
// ---------------------------------------------------------------------------------------
let visual = null
if (!noVisual && falsify === null) {
	const { chromium } = await import('playwright')
	const { startPrivateComposed } = await import('./private-composed-preview.mjs')
	let browser = null
	let preview = null
	try {
		preview = await startPrivateComposed(port)
		browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })
		const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 })).newPage()
		const pageErrors = []
		page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`))
		const url = new URL(preview.baseUrl)
		url.searchParams.set('mode', 'game')
		url.searchParams.set('platform', 'null')
		url.searchParams.set('Debug.ServerRandomSeed', '104729')
		url.searchParams.set('quality', 'high')
		await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined, { timeout: 180000, polling: 100 })
		await page.click('#session-start')
		await page.waitForFunction(() => globalThis.steelseed.ctx.snapshot?.actors?.count > 0, undefined, { timeout: 180000, polling: 100 })

		// Deploy the MCV: the construction yard it produces is the exact actor the requirement
		// names, and the only way to get one into a fresh skirmish.
		const mcv = await page.evaluate(() => {
			const s = globalThis.steelseed.ctx.snapshot
			for (let i = 0; i < s.actors.count; i++)
				if (globalThis.steelseed.ctx.actorTypeName(s.actors.typeId[i]) === 'mcv') return s.actors.id[i]
			return null
		})
		if (mcv === null) throw new Error('no MCV in the opening snapshot')
		await page.evaluate(id => globalThis.steelseed.ctx.issueOrder({ orderString: 'DeployTransform', subjectIds: Uint32Array.of(id) }), mcv)
		const yardId = await page.waitForFunction(() => {
			const s = globalThis.steelseed.ctx.snapshot
			for (let i = 0; i < s.actors.count; i++)
				if (globalThis.steelseed.ctx.actorTypeName(s.actors.typeId[i]) === 'fact')
					return { id: s.actors.id[i], x: s.actors.posX[i] / 1024, z: s.actors.posY[i] / 1024 }
			return null
		}, undefined, { timeout: 180000, polling: 200 }).then(h => h.jsonValue())

		const shotDir = join(WEB, 'shots/mushroom')
		mkdirSync(shotDir, { recursive: true })
		const AT = [0.10, 0.55, 1.35, 2.30, 4.00]
		const setup = await page.evaluate(target => {
			const app = globalThis.steelseed
			const camera = app.registry.peek('camera')
			const terrain = app.registry.peek('terrain')
			const world = app.ctx.snapshot?.world
			const ground = terrain.heightAt(target.x, target.z)
			camera.target.set([target.x, ground, target.z])
			camera.targetGoal.set([target.x, ground, target.z])
			camera.height = 22
			camera.heightGoal = 22
			camera.yaw = 0.6
			camera.yawGoal = 0.6
			if (world != null) {
				camera.boundsKnown = true
				camera.boundsMinX = world.boundsLeft; camera.boundsMaxX = world.boundsRight
				camera.boundsMinZ = world.boundsTop; camera.boundsMaxZ = world.boundsBottom
			}
			document.getElementById('boot')?.setAttribute('hidden', '')
			return { ground }
		}, yardId)
		// Let the game's own loop settle the camera onto the yard before anything is measured;
		// driving renderOneFrame from a cold camera raced the terrain node's chunk build.
		await page.waitForFunction(target => {
			const camera = globalThis.steelseed.registry.peek('camera')
			return Math.hypot(camera.eye[0] - target.x, camera.eye[2] - target.z) > 1
		}, yardId, { timeout: 60000, polling: 50 })
		// The camera pitch clamps between 48 and 62 degrees, so the cloud is only ever seen from
		// above at an angle. Report it, because a column tuned in a side view is a column judged
		// from a view the game never shows.
		setup.pitchDeg = await page.evaluate(({ target, ground }) => {
			const eye = globalThis.steelseed.registry.peek('camera').eye
			return (Math.atan2(eye[1] - ground, Math.hypot(eye[0] - target.x, eye[2] - target.z)) * 180) / Math.PI
		}, { target: yardId, ground: setup.ground })

		// ISOLATING THE CLOUD FROM A LIVE MATCH. A destroyed frame cannot be diffed against a
		// "before" frame: water, wind, the shroud and the temporal history move every pixel
		// between two moments, and the first attempt at this measured 139,000 changed pixels
		// with nothing burning at all. So each sample renders the SAME INSTANT three times.
		// `renderOneFrame` takes its timestamp, so repeating it gives dt = 0 and nothing else
		// in the scene can advance. Two of the three suppress `render.addParticle` — that is
		// the noise floor — and the third lets it through. The difference is the cloud.
		const sample = async name => {
			const measured = await page.evaluate(() => {
				const app = globalThis.steelseed
				const render = app.registry.peek('render')
				const fx = app.registry.peek('fx')
				const at = performance.now()
				const w = app.ctx.canvas.width
				const h = app.ctx.canvas.height
				const grab = () => {
					const c = document.createElement('canvas')
					c.width = w; c.height = h
					const g = c.getContext('2d')
					// A WebGPU canvas is only readable in the frame it was drawn in.
					g.drawImage(app.ctx.canvas, 0, 0)
					return g.getImageData(0, 0, w, h).data
				}
				// LIVE DEFECT, NOT THIS GATE'S: `terrain.rebuild()` is currently throwing before
				// it sizes `this.visible`, so the node has 36 chunks and a zero-length visible
				// array and `cullChunks` throws on EVERY frame — the ground is not drawn at all
				// in a freshly built bundle. (Reproduced with `terrain.update(0, ctx)` called
				// directly; the `[terrain]` boot line that rebuild logs last never appears.)
				// The cloud cannot be judged over a missing battlefield, so the arrays are
				// resized here, gate-locally, and the repair is REPORTED rather than hidden.
				const terrain = app.registry.peek('terrain')
				let repairedChunks = 0
				if (terrain?.chunks?.length > (terrain.visible?.length ?? 0)) {
					repairedChunks = terrain.chunks.length
					terrain.visible = new Int32Array(repairedChunks)
					terrain.visibleDist = new Float32Array(repairedChunks)
				}
				const real = render.addParticle.bind(render)
				const draw = suppressed => {
					render.addParticle = suppressed ? () => {} : real
					render.frameIndex = 0
					render.historyValid = false
					app.renderOneFrame(at)
					return grab()
				}
				const withoutA = draw(true)
				const withoutB = draw(true)
				const withCloud = draw(false)
				render.addParticle = real
				const compare = (a, b) => {
					let n = 0, sy = 0, sx = 0, sxx = 0, minY = h
					for (let i = 0, px = 0; i < a.length; i += 4, px++) {
						const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
						if (d <= 12) continue
						const x = px % w, y = (px / w) | 0
						n++; sy += y; sx += x; sxx += x * x; if (y < minY) minY = y
					}
					return n === 0 ? { n: 0 } : { n, cy: sy / n, cx: sx / n, sd: Math.sqrt(Math.max(0, sxx / n - (sx / n) ** 2)), top: minY }
				}
				return {
					noise: compare(withoutA, withoutB),
					cloud: compare(withoutB, withCloud),
					w, h, repairedChunks, pool: { ...fx.particleStats }, mushroom: { ...fx.mushroom.stats },
				}
			})
			// The last render inside that evaluate drew the cloud, so this is a frame with it in.
			writeFileSync(join(shotDir, `${name}.png`), await page.screenshot({ type: 'png' }))
			return measured
		}
		// `terrain.cullChunks` throws while its chunk set is being rebuilt — `this.visible` is
		// length 0 for a frame after the camera jumps, so `chunks[vis[k]]` is undefined. That is
		// terrain's to fix, not this gate's; here it just means an extra frame must not be
		// driven into the middle of a rebuild, so a sample retries rather than failing the run.
		const sampleWhenStable = async name => {
			let last = null
			for (let attempt = 0; attempt < 6; attempt++) {
				try { return await sample(name) } catch (error) { last = error; await page.waitForTimeout(400) }
			}
			throw last
		}

		// Let the terrain finish streaming the region the camera just jumped to.
		await page.waitForTimeout(1500)
		const before = await sampleWhenStable('00-before')
		// One authoritative destruction, injected the way `fxgate` injects a fire: the wire
		// record the node reads, through the real event bus, at the real actor's real id.
		await page.evaluate(id => {
			const app = globalThis.steelseed
			const v = app.ctx.snapshot.view
			const o = v.byteLength - 96
			const s = app.ctx.snapshot.actors
			let idx = -1
			for (let i = 0; i < s.count; i++) if (s.id[i] === id) idx = i
			if (idx < 0) throw new Error('the yard left the snapshot before it could be destroyed')
			v.setUint32(o, id, true)
			v.setInt32(o + 4, s.posX[idx], true)
			v.setInt32(o + 8, s.posY[idx], true)
			v.setInt32(o + 12, s.posZ[idx], true)
			v.setUint8(o + 16, 0)
			v.setUint8(o + 17, 240)
			globalThis.__mushroomStart = (app.ctx.time.tick + app.ctx.time.alpha) / 25
			app.events.emit('sim:actor:destroyed', { kind: 5, offset: o, byteLength: 18 })
		}, yardId.id)

		const frames = []
		for (const t of AT) {
			await page.waitForFunction(want => {
				const app = globalThis.steelseed
				return (app.ctx.time.tick + app.ctx.time.alpha) / 25 - globalThis.__mushroomStart >= want
			}, t, { timeout: 60000, polling: 16 })
			frames.push({ t, ...(await sampleWhenStable(`${String(Math.round(t * 100)).padStart(3, '0')}-t${t.toFixed(2)}s`)) })
		}

		const noiseFloor = Math.max(before.noise.n, ...frames.map(f => f.noise.n))
		const last = frames[frames.length - 1]
		visual = { frames, before, noiseFloor, mushroom: last.mushroom, pool: last.pool,
			repairedChunks: before.repairedChunks, pitchDeg: setup.pitchDeg, w: before.w, h: before.h, dir: shotDir }
		// The terrain defect above throws once per frame; it is reported by its own line rather
		// than as hundreds of duplicate failures. Anything else the page throws still fails.
		const unrelated = pageErrors.filter(e => !/reading 'parts'/.test(e))
		if (unrelated.length) problems.push(...unrelated.slice(0, 5))
		if (last.mushroom.started !== 1) note(`the composed run started ${last.mushroom.started} clouds for one destroyed construction yard`)
		if (last.mushroom.particles < 100) note(`the composed cloud released ${last.mushroom.particles} particles`)
		if (before.cloud.n > 200) note(`${before.cloud.n} pixels of particles were already on screen before anything was destroyed`)
		const fireball = frames[1], stem = frames[2], cap = frames[3], late = frames[4]
		const floor = Math.max(400, noiseFloor * 4)
		if (!(fireball.cloud.n > floor)) note(`the fireball drew ${fireball.cloud.n} px against a ${noiseFloor} px noise floor`)
		if (!(cap.cloud.n > floor)) note(`the cap drew ${cap.cloud.n} px against a ${noiseFloor} px noise floor`)
		// Screen Y grows downward, so rising means a SMALLER centroid y. This IS the mushroom,
		// measured in the frame: the cloud climbs, then it spreads.
		if (!(cap.cloud.cy < fireball.cloud.cy - 12))
			note(`the cloud's centroid sat at y=${fireball.cloud.cy?.toFixed(1)} px at the fireball and y=${cap.cloud.cy?.toFixed(1)} px at the cap; it did not rise`)
		if (!(cap.cloud.top < fireball.cloud.top - 24))
			note(`the cloud's top reached y=${fireball.cloud.top} px at the fireball and only y=${cap.cloud.top} px at the cap; it did not climb`)
		if (!(cap.cloud.sd > stem.cloud.sd * 1.05))
			note(`the cloud is ${cap.cloud.sd?.toFixed(1)} px wide at the cap against ${stem.cloud.sd?.toFixed(1)} px at the stem; it did not spread`)
		if (!(late.cloud.n > floor / 2)) note(`only ${late.cloud.n} px were left ${late.t} s later; a destroyed base must look fought-over`)
	} catch (error) {
		note(`composed visual witness failed: ${error.message}`)
	} finally {
		if (browser) await browser.close().catch(() => {})
		if (preview) await preview.close().catch(() => {})
	}
}

for (const line of summary) console.log(line)
if (visual !== null) {
	console.log(`${TOOL}: composed ${visual.w}x${visual.h} at ${visual.pitchDeg.toFixed(1)} deg pitch, noise floor ${visual.noiseFloor} px, shots in ${visual.dir}`)
	if (visual.repairedChunks > 0)
		console.log(`${TOOL}: NOTE — terrain shipped ${visual.repairedChunks} chunks with a zero-length visible array and threw every frame; ` +
			'this gate resized it locally so the cloud could be judged over real ground. That defect is in terrain, not here.')
	for (const f of visual.frames)
		console.log(`${TOOL}:   t=${f.t.toFixed(2)}s  cloud ${String(f.cloud.n).padStart(6)} px  centroid y ${f.cloud.cy?.toFixed(1) ?? '-'}  top y ${f.cloud.top ?? '-'}  spread ${f.cloud.sd?.toFixed(1) ?? '-'} px  (noise ${f.noise.n})`)
	console.log(`${TOOL}: cloud ${JSON.stringify(visual.mushroom)} pool ${JSON.stringify(visual.pool)}`)
}
if (problems.length) {
	console.error(`${TOOL}: FAIL`)
	for (const p of problems) console.error(`  ${p}`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — the cap opens ${(WINDOWS[L.CAP].from - WINDOWS[L.STEM].from).toFixed(2)} s after the stem, rolls over as it spreads, ` +
	`and four self-tests (including the burst this replaces) were required to go red`)
