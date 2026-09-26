#!/usr/bin/env node
// STEELSEED — tools/cookoffgate
//
// Does a destroyed VEHICLE actually cook off in stages, or just pop?
//
// The effect this replaces — `smoke` + `fire` + `debris`, all at t = 0, all at the hull
// centre — is a puff, and the same particle counter that cannot tell a mushroom from a puff
// cannot tell a cook-off from one either. What separates them is WHEN each part arrives:
// the penetration flash first, the fuel fireball out of the hull, ballistic spall, then the
// DELAYED secondary pops — a third of a second after the flash, offset off the centre line,
// which is the whole signature of ammunition still going off inside the wreck — then a
// column that cools as it climbs, then a smoulder that outlives everything.
//
// All of that is schedule, so all of it is assertable: `layerWindow` publishes the same
// three numbers per layer that `mushroomgate` judges, this gate steps the clock at 1/60 s
// through the real module with the REAL forge manifest, and checks the order the frame
// actually receives against them. The fireball and the column deliberately OVERLAP — a real
// burn has fire still rolling while the column is already standing — so the ordering claims
// here are the ones the schedule actually makes: flash first, column never before the
// fireball opens, pops never inside the flash, wreck last.
//
// Then the budget and the determinism rules the shared pool lives by: eight concurrent
// cook-offs at 50 particles each, the ninth refused and COUNTED; two runs of the same death
// produce the same records; and the killing blow's violence byte buys a strictly bigger
// fire without touching the schedule.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'cookoffgate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))

const problems = []
const note = m => problems.push(m)

// ---------------------------------------------------------------------------------------
// Fixtures: the REAL forge roster, so the hull-bounds lookup is exercised rather than mocked.
// `import.meta.glob` is Vite's and this runs under plain node — the same shim mushroomgate uses.
// ---------------------------------------------------------------------------------------
const rosterPath = join(WEB, '.forge/blender/manifest.json')
if (!existsSync(rosterPath)) {
	console.error(`${TOOL}: FATAL — no roster manifest at ${rosterPath}; run the forge first`)
	process.exit(1)
}
const roster = JSON.parse(readFileSync(rosterPath, 'utf8'))

const tmp = mkdtempSync(join(tmpdir(), 'cookoffgate-'))
const entry = join(tmp, 'e.ts')
writeFileSync(entry, `export { VehicleCookoff, VEHICLE_COOKOFF_LAYERS, SCHEDULE_PARTICLES } from '${WEB}/src/fx/vehicle-cookoff'\n`)
const bundle = join(tmp, 'b.mjs')
await esbuild({
	entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent',
	define: { 'import.meta.glob': '__cookoffGateGlob' },
	banner: { js: 'const __cookoffGateGlob = pattern => pattern.endsWith(\'blender/manifest.json\') ? { roster: globalThis.__cookoffGateRoster } : {};' },
})
globalThis.__cookoffGateRoster = roster
const { VehicleCookoff, VEHICLE_COOKOFF_LAYERS, SCHEDULE_PARTICLES } = await import(bundle)
const L = VEHICLE_COOKOFF_LAYERS

const window3 = new Float32Array(3)
const WINDOWS = []
for (let layer = 0; layer < L.LAYERS; layer++) {
	VehicleCookoff.layerWindow(layer, window3)
	WINDOWS.push({ from: window3[0], to: window3[1], count: window3[2] })
}

// ---------------------------------------------------------------------------------------
// Driving one cook-off and recording every spawn.
// ---------------------------------------------------------------------------------------
function actorsFixture(entries) {
	return {
		count: entries.length,
		id: Uint32Array.from(entries, e => e.id),
		typeId: Uint32Array.from(entries, e => e.typeId),
		facing: Uint16Array.from(entries, e => e.facing ?? 0),
		health: Uint8Array.from(entries, e => e.health ?? 255),
	}
}

/**
 * Run one vehicle destruction to completion and return every spawn, in emission order.
 * The clock steps at 1/60 s — a schedule that only works when sampled once is not one.
 */
function runCookoff({ actor = '1tnk', typeId = 7, id = 0x4321, violence = 200, x = 12.5, z = -7.25, eventY = 0.0, ground = 3.5 } = {}) {
	const cookoff = new VehicleCookoff()
	const records = []
	const sink = { spawn(name, sx, sy, sz, time, seed, scale) { records.push({ name, x: sx, y: sy, z: sz, time, seed, scale }) } }
	const shroud = { unmodelled: false, isVisible() { return true } }
	const terrain = { heightAt() { return ground } }
	const ctx = {
		snapshot: { actors: actorsFixture([{ id, typeId }]) },
		prevSnapshot: null,
		actorTypeName(t) { return t === typeId ? actor : '' },
	}
	const started = cookoff.start(id, x, eventY, z, violence, 0, ctx, terrain, shroud)
	if (!started) return { started, records, cookoff, ground: ground + eventY, x, z }
	for (let frame = 0; frame <= 60 * 6; frame++) cookoff.tick(frame / 60, sink, shroud)
	return { started, records, cookoff, ground: ground + eventY, x, z }
}

const countName = (records, name) => records.filter(r => r.name === name).length
// The burn column's cooler presets belong to no other layer, so they identify COLUMN records
// without the module's help.
const isColumnPreset = name => name === 'stemfire' || name === 'barrelsmoke'

// ---------------------------------------------------------------------------------------
// 1. A real roster vehicle starts, sized off its own hull.
// ---------------------------------------------------------------------------------------
if (!Array.isArray(roster?.assets?.['1tnk']?.bounds))
	note('1tnk has no authored bounds in the forge manifest, so hull sizing is running on the fallback')
const tank = runCookoff({ typeId: 7, id: 0x2001 })
if (!tank.started) note('a real roster vehicle (1tnk) was refused a cook-off; the puff fallback must not own vehicle deaths')

// ---------------------------------------------------------------------------------------
// 2. The staged read, in the order the frame actually receives it.
// ---------------------------------------------------------------------------------------
if (tank.started) {
	const r = tank.records
	if (r[0]?.name !== 'blastcore')
		note(`the first emission was ${r[0]?.name ?? 'nothing'}, not the penetration flash`)
	const expectedEmissions = WINDOWS.reduce((s, w) => s + w.count, 0)
	if (r.length !== expectedEmissions)
		note(`${r.length} emissions recorded against a schedule promising ${expectedEmissions}`)
	// Per-layer census on the presets that identify their layer alone.
	if (countName(r, 'blastcore') !== WINDOWS[L.FLASH].count)
		note(`${countName(r, 'blastcore')} flash emissions against a schedule of ${WINDOWS[L.FLASH].count}`)
	if (countName(r, 'rubble') !== WINDOWS[L.SPALL].count)
		note(`${countName(r, 'rubble')} spall emissions against a schedule of ${WINDOWS[L.SPALL].count}`)
	if (countName(r, 'ruinsmoke') !== WINDOWS[L.WRECK].count)
		note(`${countName(r, 'ruinsmoke')} wreck emissions against a schedule of ${WINDOWS[L.WRECK].count}`)
	// The column cools by height fraction exactly like the mushroom stem. Eight emissions
	// spread over p = i/7: three below 0.35 burn, three below 0.75 are stemfire, the last
	// two are dark barrelsmoke.
	if (countName(r, 'stemfire') !== 3 || countName(r, 'barrelsmoke') !== 2)
		note(`the column chose ${countName(r, 'stemfire')} stemfire and ${countName(r, 'barrelsmoke')} barrelsmoke; the ramp is 3 burning then 3 stemfire then 2 dark`)
	const fires = r.filter(x => x.name === 'fireball')
	if (fires.length !== WINDOWS[L.FIREBALL].count + WINDOWS[L.POPS].count + 3)
		note(`${fires.length} fireball-preset emissions; the schedule promises ${WINDOWS[L.FIREBALL].count} fuel fireballs plus ${WINDOWS[L.POPS].count} pops plus the column's own 3 incandescent seats`)
	// The column never opens before the fireball does.
	const firstFire = fires[0]?.time ?? Number.POSITIVE_INFINITY
	const firstColumn = r.find(x => isColumnPreset(x.name))?.time ?? Number.NEGATIVE_INFINITY
	if (!(firstFire < firstColumn))
		note(`the burn column opened at ${firstColumn.toFixed(3)} s, no later than the first fireball at ${firstFire.toFixed(3)} s`)
	// The delayed pops exist: fireball-preset emissions at or after the pops window opens,
	// strictly after the flash is over — the signature of ammunition still going off.
	const lateFires = fires.filter(x => x.time >= WINDOWS[L.POPS].from - 1e-9)
	if (lateFires.length < WINDOWS[L.POPS].count)
		note(`only ${lateFires.length} fireballs at or after ${WINDOWS[L.POPS].from} s; the ${WINDOWS[L.POPS].count} delayed cook-off pops are missing`)
	if (!(Math.max(...fires.map(x => x.time)) > WINDOWS[L.FLASH].to))
		note('every fireball sat inside the flash window; the cook-off has no delay in it')
	// And nothing smoky before the flash is done.
	const earlySmoke = r.filter(x => isColumnPreset(x.name) && x.time < WINDOWS[L.FLASH].to)
	if (earlySmoke.length > 0)
		note(`${earlySmoke.length} column emissions arrived inside the flash window`)
	const earlyWreck = r.filter(x => x.name === 'ruinsmoke' && x.time < WINDOWS[L.WRECK].from - 1e-9)
	if (earlyWreck.length > 0)
		note(`${earlyWreck.length} wreck emissions arrived before the wreck window opens`)
	// Spall is ballistic: it leaves at its own instant, not with the flash.
	const earlySpall = r.filter(x => x.name === 'rubble' && x.time < WINDOWS[L.SPALL].from - 1e-9)
	if (earlySpall.length > 0) note('spall left before its window opened')
}

// ---------------------------------------------------------------------------------------
// 3. Determinism. No Math.random: the same replay is the same cook-off.
// ---------------------------------------------------------------------------------------
{
	const replay = runCookoff({ typeId: 7, id: 0x2001 })
	if (JSON.stringify(replay.records) !== JSON.stringify(tank.records))
		note('two runs of the same vehicle death produced different cook-offs')
}

// ---------------------------------------------------------------------------------------
// 4. The violence byte buys a strictly bigger fire, on identical seeds.
// ---------------------------------------------------------------------------------------
{
	const overkill = runCookoff({ typeId: 7, id: 0x2011, violence: 255 })
	const tap = runCookoff({ typeId: 7, id: 0x2011, violence: 26 })
	if (!overkill.started || !tap.started) note('a violence pair failed to start, so the violence assertion is vacuous')
	else {
		const overkillMax = Math.max(...overkill.records.map(x => x.scale))
		const tapMax = Math.max(...tap.records.map(x => x.scale))
		if (!(overkillMax > tapMax))
			note(`violence 255 gave max scale ${overkillMax.toFixed(3)}, not above violence 26's ${tapMax.toFixed(3)}; the overkill read is not observable`)
	}
}

// ---------------------------------------------------------------------------------------
// 5. The pool budget, at the module's own ceiling. The ninth simultaneous cook-off is
// refused and COUNTED, never allowed to evict the battle out of the shared pool.
// ---------------------------------------------------------------------------------------
{
	const cookoff = new VehicleCookoff()
	const shroud = { unmodelled: false, isVisible() { return true } }
	const terrain = { heightAt() { return 0 } }
	const entries = []
	for (let i = 0; i < L.MAX_VEHICLES + 1; i++) entries.push({ id: 0x9000 + i, typeId: 7 })
	const ctx = { snapshot: { actors: actorsFixture(entries) }, prevSnapshot: null, actorTypeName(t) { return t === 7 ? '1tnk' : '' } }
	let ok = 0
	for (const e of entries) if (cookoff.start(e.id, 5, 0, 5, 255, 0, ctx, terrain, shroud)) ok++
	if (ok !== L.MAX_VEHICLES) note(`${ok} concurrent cook-offs started against a ceiling of ${L.MAX_VEHICLES}`)
	if (cookoff.stats.refused !== 1) note(`${cookoff.stats.refused} refusals recorded at the ceiling, expected 1`)
	// The same actor cooking off twice must not double the fire.
	const again = cookoff.start(0x9000, 5, 0, 5, 255, 0, ctx, terrain, shroud)
	if (!again) note('a repeat destruction event for an already-burning vehicle was refused instead of absorbed')
	const worst = L.MAX_VEHICLES * SCHEDULE_PARTICLES
	if (worst > 700) note(`the worst case is ${worst} of 2048 pool slots, which is more than a third of the battlefield's particles`)
}

// ---------------------------------------------------------------------------------------
// 6. The published budget agrees with the schedule it is computed from.
// ---------------------------------------------------------------------------------------
{
	const PER_EMISSION = [3, 2, 10, 2, 1, 1] // blastcore, fireball, rubble, fireball, column, ruinsmoke
	let implied = 0
	for (let layer = 0; layer < L.LAYERS; layer++) implied += WINDOWS[layer].count * PER_EMISSION[layer]
	if (implied !== SCHEDULE_PARTICLES)
		note(`SCHEDULE_PARTICLES says ${SCHEDULE_PARTICLES} but the schedule and per-emission counts imply ${implied}`)
}

// ---------------------------------------------------------------------------------------
// 7. A type with no roster entry is refused, so the caller's generic burst still owes it an
// explosion and no death is ever effectless.
// ---------------------------------------------------------------------------------------
{
	const unknown = runCookoff({ actor: 'no-such-hull', typeId: 99, id: 0x2021 })
	if (unknown.started) note('a type with no roster entry started a cook-off; the puff fallback must own it')
	if (unknown.cookoff.stats.passedThrough !== 1) note('an unresolvable type was not counted as passed through')
}

if (problems.length) {
	for (const p of problems) console.error(`${TOOL}: FAIL — ${p}`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — flash, fuel fireball, spall, ${WINDOWS[L.POPS].count} delayed pops, a cooling column and a wreck smoulder fire in schedule order, ` +
	`${SCHEDULE_PARTICLES} particles a death, ${L.MAX_VEHICLES} concurrent with the ninth refused`)
