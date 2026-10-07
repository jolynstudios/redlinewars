#!/usr/bin/env node
// STEELSEED — tools/damagestategate
//
// Proves the condition ladder is a BEHAVIOUR and not a pack that sits on disk.
//
// The failure this gate exists for is specific: a health-driven mesh selection that never
// fires still typechecks, still passes rulecheck, still builds, and still ships a perfect
// 2.9 MB of authored destruction that no player ever sees. So nothing here inspects a
// manifest and calls it proof. Every claim is driven through the real `DamageStates` with
// a real health ramp and read back off what it actually submitted.
//
// Six sections:
//   1. thresholds  — parsed out of the engine's own Health.cs, not restated here
//   2. quantisation — the exact, measured disagreement the health byte forces
//   3. selection   — a live ramp picks the rungs, advance-only, with a repair deadband
//   4. transition  — the two-phase cross-fade, sampled frame by frame
//   5. pack        — the authored ladder on disk is current and its rungs are distinct
//   6. wrecks      — structures disappear; non-structures may retain authored remains

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'damagestategate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME = resolve(WEB, '..')
const HEALTH_CS = join(GAME, 'engine/OpenRA.Mods.Common/Traits/Health.cs')
const PACKS = join(WEB, '.forge/damage-states')

const FALSIFY = (process.argv.find(a => a.startsWith('--falsify=')) ?? '').slice(10) || null
const FALSIFIABLE = new Set(['hard-swap', 'ghost-both', 'flap', 'orphan-bone'])
if (FALSIFY && !FALSIFIABLE.has(FALSIFY)) {
	console.error(`${TOOL}: --falsify must be one of ${[...FALSIFIABLE].join(', ')}`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'damagestategate-'))
const entry = join(tmp, 'e.ts')
writeFileSync(entry, [
	`export { DamageStates, conditionState, nextRung, RUNG_COUNT, TRANSITION_SECONDS } from '${WEB}/src/units/damage-states'`,
	`export { decodeBlenderAsset } from '${WEB}/src/units/blender-mesh'`,
	`export { Wrecks } from '${WEB}/src/wrecks/index'`,
	`export { Family } from '${WEB}/src/units/archetype/params'`,
	`export { EventBus, SimEvent } from '${WEB}/src/core/events'`,
].join('\n') + '\n')
const bundle = join(tmp, 'b.mjs')
// `import.meta.glob` is Vite's, and this runs under plain node. The packs are read off
// disk directly in section 5; what is under test here is the SELECTION, so the loader's
// globs are stubbed empty rather than the module being split to suit its own gate.
await esbuild({
	entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent',
	define: { 'import.meta.glob': '__gateGlob' },
	banner: { js: 'const __gateGlob = () => ({})' },
})
const { DamageStates, conditionState, nextRung, RUNG_COUNT, TRANSITION_SECONDS, decodeBlenderAsset, Wrecks, Family, EventBus, SimEvent } = await import(bundle)

const notes = []

// =============================================================================
// 1. The thresholds are the ENGINE's, read out of the engine
// =============================================================================
// Restating "25 / 50 / 75" here would make this gate agree with the renderer because both
// copied the same guess. Parsing Health.cs means an upstream change to OpenRA's ladder
// breaks the gate instead of silently desynchronising the picture from the simulation.
const healthSource = readFileSync(HEALTH_CS, 'utf8')
const block = /public DamageState DamageState\s*\{([\s\S]*?)\n\t\t\}/.exec(healthSource)
assert.ok(block, 'Health.cs no longer exposes a DamageState property this gate can read')
const parsed = [...block[1].matchAll(/HP \* 100L < MaxHP \* (\d+)L\)\s*\n\s*return DamageState\.(\w+);/g)]
	.map(m => ({ percent: Number(m[1]), state: m[2] }))
assert.deepEqual(parsed, [
	{ percent: 25, state: 'Critical' },
	{ percent: 50, state: 'Heavy' },
	{ percent: 75, state: 'Medium' },
], 'Health.cs thresholds moved; the ladder in damage-states.ts must move with them')
assert.match(block[1], /HP == MaxHP\)\s*\n\s*return DamageState\.Undamaged;/, 'Undamaged is still exactly full HP')
assert.match(block[1], /HP <= 0\)\s*\n\s*return DamageState\.Dead;/, 'Dead is still HP <= 0')

const RUNG = { Undamaged: 0, Light: 1, Medium: 2, Heavy: 3, Critical: 4, Dead: 5 }
/** OpenRA's own rule, transcribed from what was just parsed, in HP space. */
function engineRung(hp, maxHp) {
	if (hp === maxHp) return RUNG.Undamaged
	if (hp <= 0) return RUNG.Dead
	for (const { percent, state } of parsed) if (hp * 100 < maxHp * percent) return RUNG[state]
	return RUNG.Light
}
assert.equal(RUNG_COUNT, 6, 'the ladder is six rungs: intact plus DamageState\'s five')

// =============================================================================
// 2. What the health BYTE costs, measured over every real actor
// =============================================================================
// `SnapshotEmitter` sends floor(255 * HP / MaxHP). That is lossy, so perfect parity with
// Health.cs is NOT available and claiming it would be a lie. What is provable is weaker and
// exactly right: the rung the renderer picks for a byte is always a rung the simulation
// genuinely could be in for that byte. This measures that over every catalogued actor's
// real MaxHP, in BYTE space, so the answer does not depend on how finely HP is sampled.
const catalog = JSON.parse(readFileSync(join(WEB, 'src/core/ra-visual-manifest.json'), 'utf8'))
const maxHps = [...new Set(Object.values(catalog.actors)
	.map(a => a?.health?.HP).filter(v => Number.isInteger(v) && v > 0))].sort((a, b) => a - b)
assert.ok(maxHps.length >= 20, 'the catalogue should carry real MaxHP values to sweep')

let worstAmbiguous = 0, worstMaxHp = 0, ambiguousTotal = 0
for (const maxHp of maxHps) {
	// Every ALIVE HP, folded into the byte the renderer will actually be handed.
	const possible = new Map()
	for (let hp = 1; hp <= maxHp; hp++) {
		const byte = Math.min(255, Math.max(0, Math.floor(255 * hp / maxHp)))
		let set = possible.get(byte)
		if (set === undefined) possible.set(byte, set = new Set())
		set.add(engineRung(hp, maxHp))
	}
	let ambiguous = 0
	for (const [byte, set] of possible) {
		const mine = conditionState(byte)
		// THE LOAD-BEARING ASSERTION. Whatever the renderer draws for this byte must be a
		// state the simulation could actually be in at that byte. A rung outside the set is
		// not quantisation, it is the renderer lying about the fight.
		assert.ok(set.has(mine),
			`MaxHP ${maxHp}, health byte ${byte}: renderer draws rung ${mine} but the simulation can only be in {${[...set].sort().join(',')}}`)
		if (set.size > 1) ambiguous++
	}
	ambiguousTotal += ambiguous
	if (ambiguous > worstAmbiguous) { worstAmbiguous = ambiguous; worstMaxHp = maxHp }
	// Four interior boundaries, so at most four bytes can straddle one.
	assert.ok(ambiguous <= 4, `MaxHP ${maxHp} has ${ambiguous} ambiguous health bytes; at most 4 (one per boundary) is quantisation`)
}
notes.push(`${ambiguousTotal} ambiguous health bytes across ${maxHps.length} distinct MaxHP values (worst ${worstAmbiguous} at MaxHP ${worstMaxHp}); every rung drawn is one the simulation could be in`)

// The byte cannot express death, so the live ladder must never claim it. Byte 0 for the
// 60000 HP heavy tank is any HP from 1 to 235 — all alive, all still shooting.
assert.equal(conditionState(0), 4, 'a live actor at health byte 0 is Critical, never Dead: the byte floors and cannot express death')
{
	const maxHp = Math.max(...maxHps)
	let aliveAtZeroByte = 0
	for (let hp = 1; hp <= maxHp; hp++) if (Math.floor(255 * hp / maxHp) === 0) aliveAtZeroByte++
	assert.ok(aliveAtZeroByte > 1, 'the sweep should find live HP values that quantise to byte 0')
	notes.push(`health byte 0 covers ${aliveAtZeroByte} LIVE HP values at MaxHP ${maxHp}; drawing it as Dead would have shown the ruin of a building still shooting`)
}

// Full health and zero health are never ambiguous, whatever MaxHP is.
assert.equal(conditionState(255), 0, 'a pristine actor is Undamaged')
assert.equal(conditionState(254), 1, 'one point of damage is Light, never Undamaged')

// =============================================================================
// 3. Advance-only, and the repair deadband
// =============================================================================
// Damage climbs freely; healing must clear a deadband. Without the deadband a structure
// parked on a boundary under a repair truck swaps mesh every tick, which reads as a bug.
assert.equal(nextRung(0, 200), 1, 'damage advances the ladder')
assert.equal(nextRung(3, 40), 4, 'damage keeps advancing')
assert.equal(nextRung(4, 60), 4, 'a rung never drops for a health value still inside it')
{
	// Health 64 is Heavy(3) by a single byte. A structure that just crossed up from Critical
	// must NOT immediately present as Heavy, or it flickers on every repair tick.
	assert.equal(conditionState(64), 3, 'byte 64 is Heavy')
	const held = nextRung(4, 64)
	assert.equal(held, 4, 'crossing a boundary by one byte does not step the ladder down')
	let recovered = 4, health = 64
	while (recovered === 4 && health < 255) recovered = nextRung(4, ++health)
	assert.equal(recovered, 3, 'enough recovery does eventually step the ladder down')
	assert.ok(health - 64 >= 10 && health - 64 <= 25,
		`the repair deadband should be a handful of percent, measured ${health - 64} bytes`)
	notes.push(`repair deadband measured at ${health - 64}/255 bytes (${(100 * (health - 64) / 255).toFixed(1)}%) past the boundary`)
}

// =============================================================================
// 4. Live selection and the two-phase cross-fade
// =============================================================================
const mesh = n => ({ label: `mesh:${n}`, indexCount: 100 + n })
const MESHES = [mesh(0), mesh(1), mesh(2), mesh(3), mesh(4), mesh(5)]
const PARTIAL = 'part'

function build() {
	const d = new DamageStates()
	for (let r = 0; r < RUNG_COUNT; r++) d.register('powr', r, r === 0 ? 'powr' : `powr.d${r}`, MESHES[r], 'industrial-v1:powr', 7)
	// A deliberately incomplete ladder: intact plus Dead only. This is a legitimate shape and
	// the fallback must go DOWN, never invent a rung the author never made.
	d.register(PARTIAL, 0, PARTIAL, mesh(10), 'industrial-v1', 0)
	d.register(PARTIAL, 5, `${PARTIAL}.d5`, mesh(15), 'industrial-v1', 0)
	return d
}

const transform = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4.5, 1.25, -2, 1])
/** One frame: advance time, select, place, capture the fade, collect submissions. */
function frame(d, seconds, actors) {
	d.beginFrame(seconds)
	const opaque = []
	for (const a of actors) {
		const slot = d.opaqueSlot(a.id, a.actor, a.health)
		opaque.push(slot)
		d.capture(a.id, a.actor, a.health, transform, 0, 3, 11)
	}
	const ghosts = []
	d.submit({ submit: item => ghosts.push({ mesh: item.mesh, opacity: item.opacity, castsShadow: item.castsShadow, boneCount: item.boneCount, paletteBase: item.paletteBases[0], damage: item.damages[0] }) })
	return { opaque, ghosts }
}

{
	const d = build()
	// A ramp from pristine to dead, one snapshot tick apart, long enough for each fade to
	// finish before the next hit lands.
	const ramp = [255, 200, 160, 120, 100, 60, 40, 1, 0]
	const seen = []
	let t = 0
	for (const health of ramp) {
		// The hit frame is phase 1 of the fade and still draws the OUTGOING rung opaque, which
		// is the whole point of the two-phase design. Settle the fade, then record where the
		// ladder actually landed.
		frame(d, t, [{ id: 42, actor: 'powr', health }])
		t += 1
		seen.push(frame(d, t, [{ id: 42, actor: 'powr', health }]).opaque[0])
		t += 1
	}
	assert.deepEqual(seen, ['powr', 'powr.d1', 'powr.d2', 'powr.d3', 'powr.d3', 'powr.d4', 'powr.d4', 'powr.d4', 'powr.d4'],
		'a health ramp must walk the authored rungs and stop at Critical: a LIVE actor is never Dead')
	assert.equal(d.rungOf(42), 4, 'the live ladder tops out at Critical; Dead is bound by wrecks off the destruction event')
	assert.ok(d.stats.transitions >= 4, `a full ramp is at least four rung changes, saw ${d.stats.transitions}`)
	notes.push(`health ramp 255->0 selected ${new Set(seen).size} distinct rungs over ${d.stats.transitions} transitions`)
}

{
	// THE CROSS-FADE, SAMPLED. This is the assertion the human's "smooth and realistic" ask
	// actually rests on, so it is read frame by frame rather than trusted.
	const d = build()
	frame(d, 0, [{ id: 7, actor: 'powr', health: 255 }])
	const samples = []
	// Damage lands at t=1.0. Sample across the whole fade at 120 Hz.
	for (let i = 0; i <= 40; i++) {
		const seconds = 1 + i * (TRANSITION_SECONDS / 30)
		const f = frame(d, seconds, [{ id: 7, actor: 'powr', health: 200 }])
		samples.push({ t: (seconds - 1) / TRANSITION_SECONDS, opaque: f.opaque[0], ghosts: f.ghosts })
	}
	// The endpoints draw nothing on purpose: at alpha 0 the ghost is invisible and a
	// translucent draw of it would be pure cost. Everything strictly inside must fade.
	assert.equal(samples[0].ghosts.length, 0, 'a fade at alpha zero must not cost a translucent draw')
	const during = samples.filter(s => s.t > 0.02 && s.t < 0.98)
	assert.ok(during.length >= 25, 'the fade must span many frames, not one')
	for (const s of during) {
		assert.equal(s.ghosts.length, 1, `exactly one fading half at t=${s.t.toFixed(3)}, saw ${s.ghosts.length}`)
		const g = s.ghosts[0]
		assert.equal(g.castsShadow, false, 'the fading half must not cast a second shadow')
		assert.ok(g.opacity > 0 && g.opacity <= 1, `ghost opacity in (0,1] at t=${s.t.toFixed(3)}, saw ${g.opacity}`)
		// EXACTLY ONE OPAQUE MESH AT EVERY INSTANT. This is the property that keeps shared
		// geometry solid and the shadow alive; a symmetric dissolve has none.
		const opaqueMesh = MESHES[s.opaque === 'powr' ? 0 : Number(s.opaque.slice(-1))]
		assert.notEqual(g.mesh, opaqueMesh, `the ghost must never be the mesh already drawn opaque (t=${s.t.toFixed(3)})`)
		assert.equal(g.boneCount, 7, 'the ghost shares the opaque half\'s bone count')
		assert.equal(g.paletteBase, 11, 'the ghost reuses the palette the opaque half reserved')
		assert.ok(Math.abs(g.damage - (1 - 200 / 255)) < 1e-6, 'the ghost carries the same continuous soot as the opaque half')
	}
	// Phase 1 keeps the OUTGOING rung opaque so what the new rung adds can fade in; phase 2
	// hands opacity to the INCOMING rung so what it removed can fade out.
	const first = during.filter(s => s.t < 0.5 - 1e-6)
	const second = during.filter(s => s.t > 0.5 + 1e-6)
	assert.ok(first.every(s => s.opaque === 'powr'), 'phase 1 draws the outgoing rung opaque')
	assert.ok(second.every(s => s.opaque === 'powr.d1'), 'phase 2 draws the incoming rung opaque')
	assert.ok(first.every(s => s.ghosts[0].mesh === MESHES[1]), 'phase 1 fades the incoming rung IN')
	assert.ok(second.every(s => s.ghosts[0].mesh === MESHES[0]), 'phase 2 fades the outgoing rung OUT')
	// Continuity: the alpha curve rises to 1 at the handover and falls back to 0, and no
	// single frame jumps more than one step of the ramp. A jump is a pop.
	const alphas = during.map(s => s.ghosts[0].opacity)
	const peak = Math.max(...alphas)
	assert.ok(peak > 0.9, `the fade must reach the handover, peak alpha was ${peak.toFixed(3)}`)
	assert.ok(alphas[0] < 0.2 && alphas[alphas.length - 1] < 0.2, 'the fade starts and ends near zero')
	let biggestStep = 0
	for (let i = 1; i < alphas.length; i++) biggestStep = Math.max(biggestStep, Math.abs(alphas[i] - alphas[i - 1]))
	assert.ok(biggestStep < 0.2, `the alpha ramp must be continuous; largest single-frame step was ${biggestStep.toFixed(3)}`)
	// After the fade there is nothing left to draw twice.
	const after = frame(d, 1 + TRANSITION_SECONDS * 2, [{ id: 7, actor: 'powr', health: 200 }])
	assert.equal(after.ghosts.length, 0, 'the fade stops when it is over')
	assert.equal(after.opaque[0], 'powr.d1', 'the incoming rung is what remains')
	notes.push(`cross-fade sampled at ${during.length} frames: one opaque half throughout, alpha peak ${peak.toFixed(2)}, largest step ${biggestStep.toFixed(3)}`)
}

{
	// A partly authored ladder falls DOWN to the nearest authored rung, so a missing rung can
	// only ever show an actor as less hurt than it is — never as more hurt than the
	// simulation has actually made it.
	const d = build()
	const f = frame(d, 0, [{ id: 9, actor: PARTIAL, health: 100 }])
	assert.equal(f.opaque[0], PARTIAL, 'an unauthored Medium rung falls back to the intact mesh')
	assert.equal(f.ghosts.length, 0, 'a fallback that resolves to the same mesh submits no ghost')
	const dying = frame(d, 4 + TRANSITION_SECONDS, [{ id: 9, actor: PARTIAL, health: 1 }])
	assert.equal(dying.opaque[0], PARTIAL,
		'with no Light..Critical rungs authored the fallback goes DOWN to intact, never up to the Dead ruin of a live actor')
	assert.equal(d.opaqueSlot(1, 'no-such-actor', 128), null, 'an actor with no ladder keeps its own bucket')
}

{
	// A first sighting must not fade. Scouting a building that is already at 30% is not the
	// same event as watching it be hit, and fading it down from intact would invent history.
	const d = build()
	const f = frame(d, 12, [{ id: 500, actor: 'powr', health: 70 }])
	assert.equal(f.opaque[0], 'powr.d3', 'a newly seen damaged actor snaps to its real rung')
	assert.equal(f.ghosts.length, 0, 'a newly seen actor does not cross-fade from a state it was never in')
}

{
	// HEAVY/CRITICAL CROSSINGS ARE PUBLISHED. A damage-direction crossing into rung 3 or 4
	// is the just-took-a-serious-hit moment fx answers with a burst, so the ladder hands the
	// event over — once per crossing, damage-direction only, and never on a first sighting.
	// Drain accumulates: drive both thresholds before draining once.
	const d = build()
	const got = []
	frame(d, 0, [{ id: 42, actor: 'powr', health: 255 }])
	frame(d, 1, [{ id: 42, actor: 'powr', health: 120 }])   // 50% boundary crossed: Heavy
	frame(d, 2, [{ id: 42, actor: 'powr', health: 60 }])    // 25% boundary crossed: Critical
	d.drainTransitions((id, rung) => got.push([id, rung]))
	assert.deepEqual(got, [[42, 3], [42, 4]], 'crossing into Heavy then Critical publishes (id, 3) then (id, 4), in order')
	// A repair stepping the ladder back down uses the same transition branch; healing is
	// not news and the ring must come back empty.
	frame(d, 3, [{ id: 42, actor: 'powr', health: 200 }])
	got.length = 0
	d.drainTransitions((id, rung) => got.push([id, rung]))
	assert.deepEqual(got, [], 'a repair stepping back down the ladder records no crossing')
	// First sighting at low health snaps without publishing: a ruin scouted at 30% was not
	// just hit, and inventing a burst for it would fabricate history.
	const d2 = build()
	frame(d2, 0, [{ id: 77, actor: 'powr', health: 40 }])
	got.length = 0
	d2.drainTransitions((id, rung) => got.push([id, rung]))
	assert.deepEqual(got, [], 'a first sighting already at Critical health records no crossing')
	// And an empty drain is free: the per-frame cost when nothing crossed is one compare.
	got.length = 0
	d2.drainTransitions((id, rung) => got.push([id, rung]))
	assert.deepEqual(got, [], 'draining a second time yields nothing')
	notes.push('Heavy/Critical crossings drained in order; repairs and first sightings stay silent')
}

{
	// The fade pool is finite by design. A mass-damage event past its capacity does NOT
	// hard-swap any more: the ghost closest to done is recycled for the newcomer, and every
	// recycle is COUNTED rather than silently absorbed.
	const d = build()
	const many = []
	for (let i = 0; i < 200; i++) many.push({ id: 1000 + i, actor: 'powr', health: 255 })
	frame(d, 20, many)
	for (const a of many) a.health = 100
	frame(d, 21, many)                       // the hit lands; alpha is still zero here
	const f = frame(d, 21 + TRANSITION_SECONDS * 0.4, many)
	assert.ok(f.ghosts.length > 0 && f.ghosts.length < many.length, 'the fade pool is bounded')
	assert.equal(d.stats.stolen, many.length - f.ghosts.length, 'every recycled fade is counted as a steal')
	assert.equal(d.stats.evictions, 0, 'the condition table holds 200 simultaneous actors without eviction')
	notes.push(`${f.ghosts.length} simultaneous cross-fades drawn, ${d.stats.stolen} ghosts recycled for later arrivals`)
}

{
	// WHO gets recycled: the fade closest to done, not the loudest. Two staggered waves fill
	// the pool with ghosts of different ages; the next arrival must take the OLDEST fade's
	// slot, so the pop a steal costs is always the smallest one on offer.
	const d = build()
	const a = Array.from({ length: 24 }, (_, i) => ({ id: 100 + i, actor: 'powr', health: 255 }))
	const b = Array.from({ length: 24 }, (_, i) => ({ id: 200 + i, actor: 'powr', health: 255 }))
	const c = [{ id: 300, actor: 'powr', health: 255 }]
	frame(d, 0, [...a, ...b, ...c])          // everyone sighted intact: later drops are transitions
	for (const x of a) x.health = 100        // wave A is hit first
	frame(d, 10, [...a, ...b, ...c])
	for (const x of b) x.health = 110        // wave B a little later
	frame(d, 10 + TRANSITION_SECONDS * 0.12, [...a, ...b, ...c])
	for (const x of c) x.health = 120        // the pool-full arrival, hit one frame before it can fade
	const full = frame(d, 10 + TRANSITION_SECONDS * 0.24, [...a, ...b, ...c])
	assert.equal(full.ghosts.length, 48, 'two half-strength waves fill the pool exactly')
	const stole = frame(d, 10 + TRANSITION_SECONDS * 0.44, [...a, ...b, ...c])
	assert.equal(stole.ghosts.length, 48, 'a pool-full arrival recycles rather than grows the pool')
	assert.equal(d.stats.stolen, 1, 'exactly one ghost was recycled for the pool-full arrival')
	const byWave = [100, 110, 120].map(h => stole.ghosts.filter(g => Math.abs(g.damage - (1 - h / 255)) < 1e-6).length)
	assert.deepEqual(byWave, [23, 24, 1],
		`the stolen slot belonged to the oldest wave (closest to done), saw ${byWave.join('/')}`)
	notes.push(`pool-full arrival recycled the closest-to-done fade: oldest wave ${byWave[0]}/24, younger wave ${byWave[1]}/24, newcomer drawn`)
}

// =============================================================================
// 5. The authored pack on disk
// =============================================================================
{
	const roster = JSON.parse(readFileSync(join(WEB, '.forge/blender/manifest.json'), 'utf8'))
	const { readdirSync } = await import('node:fs')
	assert.ok(existsSync(PACKS), 'the damage-states pack directory must exist')
	const actors = readdirSync(PACKS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
	assert.ok(actors.length >= 2, `at least the two proof actors must ship a ladder, found ${actors.length}`)
	const summary = []
	for (const actor of actors) {
		const manifest = JSON.parse(readFileSync(join(PACKS, actor, 'manifest.json'), 'utf8'))
		assert.equal(manifest.actor, actor, `${actor}: manifest names a different actor`)
		assert.equal(manifest.schema, 1, `${actor}: unsupported ladder schema`)
		// STALENESS IS A BUILD FAILURE, NOT A WRONG RENDER. Every rung is cut from the parent
		// scene, so a parent that has moved since leaves the whole ladder drawing a mesh that
		// no longer exists. This is the exact state the pack was found in before this pass.
		const shipped = roster.assets[actor]
		assert.ok(shipped, `${actor}: a ladder exists for an actor the roster does not ship`)
		// STALENESS IS A BUILD FAILURE, NOT A WARNING. Every rung is cut from the parent
		// scene, so a parent that has moved leaves the whole ladder drawing a mesh that no
		// longer exists. The runtime refuses to load such a pack, so the visible symptom is
		// a silently missing ladder; this is what says so out loud, with the fix.
		assert.equal(manifest.parentSourceSha256, shipped.sourceSha256,
			`${actor}: the ladder was authored against a different ${actor}.blend than the roster ships.\n` +
			`    Fix, after the roster is next forged:\n` +
			`    blender --background --factory-startup --python art/blender/damage_states.py -- --actor ${actor} --author --export --render`)
		const states = manifest.states
		// THE INTACT RUNG IS NO LONGER IN THE PACK, AND ITS ABSENCE IS NOW THE ASSERTION.
		// `units/index.ts` registers rung 0 from the ROSTER bucket and its loop skips any
		// state that maps to rung 0, so the copy the pack used to carry was downloaded,
		// length-checked, SHA-256'd and then thrown away — measured at 18-20% of every
		// ladder and 0.93 MB gzipped across the four that shipped. Dropping it also makes
		// every check below STRONGER rather than weaker: the reference for the bone array,
		// the drawn envelope and the first rung's delta is now the mesh the runtime will
		// really draw beside these rungs, not a second copy of it inside the same file.
		const RUNGS = ['Light', 'Medium', 'Heavy', 'Critical', 'Dead']
		assert.ok(states.length >= 1 && states.length <= RUNGS.length,
			`${actor}: a ladder is one to five rungs, found ${states.length}`)
		assert.ok(!states.some(s => s.state === 'Undamaged'),
			`${actor}: the pack still ships the intact rung, which the runtime never reads`)
		// A partial ladder is legitimate — an aircraft skips the rung whose silhouette does
		// not change — but the rungs it does ship must be in DamageState order and end at Dead.
		const order = states.map(s => RUNGS.indexOf(s.state))
		assert.ok(order.every(i => i >= 0), `${actor}: an unknown rung name in ${states.map(s => s.state).join(',')}`)
		assert.deepEqual(order, [...order].sort((a, b) => a - b), `${actor}: rungs are out of DamageState order`)
		assert.equal(states.at(-1).state, 'Dead', `${actor}: a ladder must end at the Dead rung`)
		// Every rung shares the SHIPPED actor's bone array, which is what lets a cross-fade
		// reuse one palette — and rung 0 of that fade is the roster mesh itself.
		const bones = JSON.stringify(shipped.rig?.bones ?? null)
		for (const s of states)
			assert.equal(JSON.stringify(s.rig?.bones ?? null), bones, `${actor}.${s.state}: rungs must share the shipped actor's bone array`)
		// FX ANCHORS MUST REACH THE MANIFEST. They were authored into every variant from the
		// first ladder onwards and carried only as far as `states.author.json`, which no
		// runtime and no gate reads — so `web/src/fx/damage-smoke.ts` had nothing to consume
		// and the answer to "are the anchors used" could not have been yes. This is what
		// stops that happening again.
		// A rung from Heavy down is on fire by definition and must say where. Light and Medium
		// may legitimately carry none — `1tnk`'s Medium is a scoop out of the glacis and a
		// scorched deck plate, which is damage without a fire — and those rungs fall back to
		// the measured stand-in anchor in `damage-smoke.ts`, so they still smoke.
		const BURNING = new Set(['Heavy', 'Critical', 'Dead'])
		assert.ok(states.some(s => (s.fx?.length ?? 0) > 0), `${actor}: no fire or smoke anchor reached the manifest at all`)
		for (const s of states) {
			assert.ok(Array.isArray(s.fx ?? []), `${actor}.${s.state}: fx is not a list`)
			assert.ok(!BURNING.has(s.state) || (s.fx?.length ?? 0) > 0,
				`${actor}.${s.state}: a rung this far gone must name where it burns`)
			for (const a of s.fx ?? []) {
				assert.ok(typeof a.kind === 'string' && a.kind.length > 0, `${actor}.${s.state}: an anchor has no kind`)
				assert.ok(a.intensity > 0 && a.intensity <= 1, `${actor}.${s.state}: anchor intensity out of range`)
				for (let x = 0; x < 3; x++)
					assert.ok(a.atM[x] >= shipped.bounds[0][x] - 0.25 && a.atM[x] <= shipped.bounds[1][x] + 0.25,
						`${actor}.${s.state}: anchor ${JSON.stringify(a.atM)} is outside the drawn actor on axis ${x}`)
			}
		}
		// A rung indistinguishable from its neighbour is not a rung. Require a real change of
		// content between every adjacent pair, and report the weakest step out loud.
		let weakest = Infinity, weakestPair = ''
		const chain = [{ state: 'Undamaged', sha256: shipped.sha256, triangles: shipped.triangles }, ...states]
		for (let i = 1; i < chain.length; i++) {
			assert.notEqual(chain[i].sha256, chain[i - 1].sha256, `${actor}: ${chain[i].state} is byte-identical to ${chain[i - 1].state}`)
			const delta = Math.abs(chain[i].triangles - chain[i - 1].triangles) / chain[i - 1].triangles
			if (delta < weakest) { weakest = delta; weakestPair = `${chain[i - 1].state}->${chain[i].state}` }
		}
		// Drawn bounds may only ever SHRINK: culling spheres, shroud tests and the placement
		// grid are all sized from the intact actor.
		// A deployable actor's roster bounds describe its compact transport state; its
		// damage states describe the deployed building. When the ladder declares the
		// deployed drawn envelope, states are checked against that instead.
		const drawn = manifest.drawnEnvelope
		const [lo0, hi0] = drawn ?? shipped.bounds
		for (const s of states) {
			const [lo, hi] = s.bounds
			for (let a = 0; a < 3; a++)
				assert.ok(lo[a] >= lo0[a] - 1e-4 && hi[a] <= hi0[a] + 1e-4,
					`${actor}.${s.state}: leaves the intact drawn envelope on axis ${a}`)
		}
		assert.ok(states.at(-1).bounds[1][1] < shipped.bounds[1][1],
			`${actor}: the Dead rung must be shorter than the intact actor`)
		// EVERY RUNG MUST SURVIVE THE REAL DECODER, not just look right in the manifest.
		// This is the assertion that was missing: three of ten rungs — both Dead states and
		// one Critical — passed every structural check here and were then thrown out by
		// `decodeBlenderAsset` at load with "Blender joint owns no geometry", so the ladder
		// silently stopped one or two rungs short of the ruin it exists to draw. A manifest
		// that parses is not a mesh that loads.
		const raw = readFileSync(join(PACKS, actor, 'states.ssmesh'))
		assert.equal(raw.byteLength, manifest.bytes, `${actor}: pack length disagrees with its manifest`)
		assert.equal(createHash('sha256').update(raw).digest('hex'), manifest.sha256, `${actor}: pack SHA-256 mismatch`)
		const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
		const boneCounts = []
		for (const state of states) {
			let decoded
			try { decoded = decodeBlenderAsset(bytes, state) }
			catch (error) { assert.fail(`${actor}.${state.state} does not load: ${error.message}`) }
			assert.equal(decoded.mesh.triangleCount, state.triangles, `${actor}.${state.state}: decoded triangles disagree`)
			// A rung must keep exactly the parent's skinning — and 34 of the actors that now
			// carry a ladder are UNSKINNED (every house, the landing craft, four of the eight
			// aeroplanes), so "has a rig" is not the invariant. "Agrees with the actor the
			// roster ships" is, in both directions: a rung that gained a rig the parent does
			// not have would be posed by a palette nothing reserved.
			assert.equal(!!decoded.rig, !!shipped.rig,
				`${actor}.${state.state}: rig presence disagrees with the shipped actor`)
			boneCounts.push(decoded.rig ? decoded.rig.skeleton.boneCount : 0)
			// A stopped rung must not still drive anything. A levelled plant whose turbine
			// spins, or a burnt-out hull whose empty turret ring tracks a target, is a lie.
			if (state.state === 'Dead' && decoded.rig) {
				const moving = decoded.rig.turretBones.length + decoded.rig.wheelBones.length +
					decoded.rig.rotorBones.length + decoded.rig.legBones.length + decoded.rig.oscillatorBones.length
				assert.equal(moving, 0, `${actor}.Dead still drives ${moving} joint(s); a wreck does not move`)
			}
		}
		// The shared bone COUNT is what lets a cross-fade reuse one palette instead of
		// reserving and skinning a second.
		assert.equal(new Set(boneCounts).size, 1, `${actor}: rungs disagree on bone count (${boneCounts.join(',')}); a cross-fade could not share a palette`)
		const anchors = states.reduce((n, s) => n + (s.fx?.length ?? 0), 0)
		summary.push(`${actor} ${shipped.triangles} intact -> [${states.map(s => s.triangles).join(', ')}] tris, ` +
			`all ${states.length} decode, ${boneCounts[0]} shared bones, ${anchors} fx anchors, ` +
			`peak ${shipped.bounds[1][1].toFixed(2)}->${states.at(-1).bounds[1][1].toFixed(2)} m, ` +
			`weakest step ${weakestPair} ${(weakest * 100).toFixed(1)}%, ${(manifest.storedBytes / 1024).toFixed(0)} kB gz`)
	}
	for (const line of summary) notes.push(line)
}

// =============================================================================
// 6. Structures disappear after collapse; other actors may retain a Dead rung
// =============================================================================
{
	const actors = JSON.parse(readFileSync(join(WEB, 'src/units/ra-visual-manifest.json'), 'utf8')).actors
	const buildings = Object.entries(actors).filter(([, visual]) => visual.renderable && visual.visualFamily === 'structure' && visual.slot)
	assert.ok(buildings.length > 0, 'no rendered structures were checked')
	for (const [name, visual] of buildings)
		assert.ok(visual.slot.family === Family.plant || visual.slot.family === Family.emplacement,
			`${name} structure would bypass the disappearing-building death path`)
	const intact = { label: 'wreck:intact', indexCount: 300 }
	const deadMesh = { label: 'wreck:d5', indexCount: 90 }
	const OFFSET = 0
	const buffer = new ArrayBuffer(64)
	const view = new DataView(buffer)
	view.setUint32(OFFSET, 0xabc, true)
	view.setInt32(OFFSET + 4, Math.round(3 * 1024), true)
	view.setInt32(OFFSET + 8, Math.round(-1 * 1024), true)
	const placed = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0.5, -1, 1])

	const run = (deadRung, deathKind) => {
		const events = new EventBus()
		const submitted = []
		const units = {
			deathKindOf: () => deathKind,
			deadRungOf: m => (m === intact ? deadRung : null),
			visitVisuals(visit) { visit(intact, 'industrial-v1'); visit(deadMesh, 'industrial-v1') },
			captureActorVisual(_id, out, off, cap) {
				for (let i = 0; i < 16; i++) out[off + i] = placed[i]
				cap.mesh = intact; cap.surfaceSet = 'industrial-v1'; cap.playerColor = 2; cap.boneCount = 0; cap.paletteBase = 0
				return true
			},
		}
		const wrecks = new Wrecks()
		wrecks.init({
			events,
			snapshot: { view },
			get: name => ({ render: { submit: i => submitted.push(i) }, units, shroud: { unmodelled: false, isVisible: () => true } })[name],
		})
		events.emit(SimEvent.actorDestroyed, { kind: 5, offset: OFFSET, byteLength: 18 })
		wrecks.update(0.016, {})
		return { wrecks, submitted }
	}

	// Non-building actors may retain an authored Dead rung.
	const withLadder = run({ mesh: deadMesh, surfaceSet: 'industrial-v1' }, 4)
	assert.equal(withLadder.submitted.length, 1, 'an authored non-building remnant persists exactly one wreck')
	assert.equal(withLadder.submitted[0].mesh, deadMesh, 'the persisted wreck is the authored Dead rung, not the intact mesh')
	assert.equal(withLadder.wrecks.stats.deadRungBound, 1, 'binding the Dead rung is counted')

	// Every building/emplacement is death kind 5. Its collapse is handled by the
	// bounded DeathVisuals path; neither a Dead rung nor the last live mesh remains.
	for (const deadRung of [{ mesh: deadMesh, surfaceSet: 'industrial-v1' }, null]) {
		const structure = run(deadRung, 5)
		assert.equal(structure.submitted.length, 0, 'destroyed structure must leave no persistent mesh')
		assert.equal(structure.wrecks.stats.retained, 0, 'destroyed structure must leave no persistent wreck')
	}

	// Without a ladder, nothing about the old behaviour changes.
	const noLadder = run(null, 4)
	assert.equal(noLadder.submitted[0].mesh, intact, 'an actor with no ladder still persists its last drawn mesh')
	assert.equal(noLadder.wrecks.stats.deadRungBound, 0)

	// An animated vehicle death with no authored remains is still left to the fall/fade path.
	const animated = run(null, 2)
	assert.equal(animated.submitted.length, 0, 'an animated death with no Dead rung stays with DeathVisuals')

	// ... but an authored Dead rung IS the authored remains, and outranks the skip.
	const animatedWithRung = run({ mesh: deadMesh, surfaceSet: 'industrial-v1' }, 2)
	assert.equal(animatedWithRung.submitted[0].mesh, deadMesh, 'an authored Dead rung persists even for an animated death')
	notes.push('structures disappear after their bounded collapse; non-structures may retain authored Dead rungs')
}

// =============================================================================
// Falsification — the gate must fail when the behaviour is broken
// =============================================================================
if (FALSIFY) {
	const d = build()
	let caught = null
	try {
		if (FALSIFY === 'hard-swap') {
			// Pretend the fade never happens: sample only after it has expired.
			frame(d, 0, [{ id: 3, actor: 'powr', health: 255 }])
			const f = frame(d, 1 + TRANSITION_SECONDS * 4, [{ id: 3, actor: 'powr', health: 200 }])
			assert.ok(f.ghosts.length > 0, 'a hard swap submits no fading half')
		} else if (FALSIFY === 'ghost-both') {
			// Assert the symmetric dissolve this design deliberately rejects.
			frame(d, 0, [{ id: 4, actor: 'powr', health: 255 }])
			const f = frame(d, TRANSITION_SECONDS * 0.5, [{ id: 4, actor: 'powr', health: 200 }])
			assert.equal(f.ghosts.length, 2, 'a symmetric dissolve would submit two translucent halves')
		} else if (FALSIFY === 'orphan-bone') {
			// The exact failure that silently dropped both Dead rungs: a bone that owns no
			// geometry. Append one to a rung that really loads and confirm the decoder — the
			// same function section 5 runs on every rung — still throws.
			const actor = '1tnk'
			const manifest = JSON.parse(readFileSync(join(PACKS, actor, 'manifest.json'), 'utf8'))
			const raw = readFileSync(join(PACKS, actor, 'states.ssmesh'))
			const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
			const dead = manifest.states[5]
			decodeBlenderAsset(bytes, dead)                       // loads as shipped
			const orphaned = { ...dead, rig: { ...dead.rig, bones: [...dead.rig.bones, { name: 'orphan', kind: 1, parent: 0, pos: [0, 0, 0] }] } }
			decodeBlenderAsset(bytes, orphaned)                   // must not
			assert.fail('a rig bone owning no geometry was accepted')
		} else {
			// Assert that a boundary-straddling repair flaps, which the deadband prevents.
			assert.notEqual(nextRung(4, 64), 4, 'without a deadband a one-byte recovery steps the ladder down')
		}
	} catch (error) { caught = error }
	assert.ok(caught, `${TOOL}: --falsify=${FALSIFY} did not fail; the gate is not measuring what it claims`)
	console.log(`${TOOL}: FALSIFIED (${FALSIFY}) — ${caught.message}`)
	process.exit(0)
}

console.log(`${TOOL}: PASS`)
for (const line of notes) console.log(`  ${line}`)

// =============================================================================
// 7. Runtime witness (--runtime): the ladder in a real browser, on real frames
// =============================================================================
// Everything above runs the module in isolation. That proves the arithmetic and it proves
// the pack, and it would still pass if `units` never called any of it — which is exactly
// the failure this whole feature is prone to. So this boots the actual app, reads the
// buckets `units` really created, drives an actor's health down through the ladder and
// reads back which mesh the renderer was actually handed.
if (process.argv.includes('--runtime')) {
	const { launchGpuBrowser, loadChromium, startPreview, stopChild } = await import('./harness.mjs')
	const preview = await startPreview(8417)
	let browser
	try {
		;({ browser } = await launchGpuBrowser(await loadChromium('damagestategate'), 'damagestategate'))
		const page = await browser.newPage({ viewport: { width: 900, height: 650 }, deviceScaleFactor: 1 })
		const pageErrors = []
		page.on('pageerror', e => pageErrors.push(e.message))
		await page.addInitScript(() => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {} })
		await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&devsize=48&devactors=1&devcluster=2&devtod=600`)
		await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 180000, polling: 100 })
		const seen = await page.evaluate(() => {
			const app = globalThis.steelseed; app.stop()
			const units = app.ctx.get('units')
			for (let i = 0; i < 8; i++) app.renderOneFrame(i * 1000 / 60)
			// Point every actor at a laddered building so the dev map is guaranteed to contain
			// one, exactly as forgegate does to guarantee a tank. Types resolve on the first
			// snapshot, so this has to happen AFTER a frame has run or the map is still empty.
			for (const key of units.typeSlot.keys()) { units.typeSlot.set(key, 'powr'); units.typeVehicle.set(key, false) }
			// The snapshot object is REPLACED every tick, so a health value written into the
			// array captured here is read back by nobody: `units` is already looking at the
			// next one. Write it at the end of the node's own snapshot handler instead, which
			// is the last point before `update` reads it.
			let target = 255
			const realOnSnapshot = units.onSnapshot.bind(units)
			units.onSnapshot = (snap, prev, ctx) => {
				realOnSnapshot(snap, prev, ctx)
				const a = snap.actors
				if (a) for (let i = 0; i < a.count; i++) a.health[i] = target
			}
			const buckets = {}
			const walk = []
			let frame = 24
			// Full health, then one step per rung, settling each fade before reading.
			for (const health of [255, 200, 160, 120, 60]) {
				target = health
				app.renderOneFrame(frame++ * 1000 / 60)
				app.renderOneFrame(frame++ * 1000 / 60)
				const mid = { dissolves: units.damageStats.dissolves, health: app.ctx.snapshot.actors.health[0] }
				for (let i = 0; i < 40; i++) app.renderOneFrame(frame++ * 1000 / 60)
				const drawn = []
				for (const [name, b] of units.slotBuckets) if (b.count > 0 && name.startsWith('powr')) drawn.push([name, b.count])
				walk.push({ health, seen: mid.health, drawn, midDissolves: mid.dissolves })
			}
			for (const [name, b] of units.slotBuckets) if (name.startsWith('powr')) buckets[name] = b.mesh !== null
			return {
				stats: { ...units.damageStats },
				forgeErrors: units.forgeStats.errors.filter(e => /\.d[1-5]\b/.test(e)),
				buckets, walk, actorCount: app.ctx.snapshot.actors.count,
			}
		})
		assert.deepEqual(pageErrors, [], 'the app must boot with no page errors')
		assert.deepEqual(seen.forgeErrors, [], `every authored rung must load in the browser: ${seen.forgeErrors.join('; ')}`)
		// stats.laddered counts laddered TYPES (65 building types as of the
		// completion/proc rounds) and stats.rungs counts every condition rung
		// across all systems, so exact arithmetic no longer holds. The floor from
		// the original assertion stays; the real witnesses are the powr rung
		// buckets, the health ramp and the transitions below.
		assert.ok(seen.stats.laddered >= 4, `at least four laddered types, browser reported ${seen.stats.laddered}`)
		for (const rung of ['powr.d1', 'powr.d2', 'powr.d3', 'powr.d4', 'powr.d5'])
			assert.equal(seen.buckets[rung], true, `${rung} has no bucket with a mesh in the running app`)
		// THE WITNESS. A health ramp must move the actors between real buckets. If selection
		// were never wired, every reading below would name `powr` and nothing else.
		const settled = seen.walk.map(w => w.drawn.filter(([, n]) => n > 0).map(([n]) => n).sort().join('+'))
		assert.equal(settled[0], 'powr', 'a full-health actor draws the intact mesh')
		const distinct = new Set(settled)
		assert.ok(distinct.size >= 4, `the ramp must move actors between rungs, saw ${JSON.stringify(settled)}`)
		assert.ok(settled[settled.length - 1].includes('powr.d4'), `a Critical actor must draw powr.d4, saw ${settled[settled.length - 1]}`)
		assert.ok(seen.stats.transitions > 0, 'the browser must have observed rung transitions')
		assert.ok(seen.walk.slice(1).some(w => w.midDissolves > 0),
			'a rung change must submit a cross-fade in the running renderer')
		const peakDissolve = Math.max(...seen.walk.map(w => w.midDissolves))
		console.log(`${TOOL}: RUNTIME PASS — ${seen.stats.laddered} ladders / ${seen.stats.rungs} rungs live in the browser, ` +
			`0 rung load errors, ${seen.actorCount} actors walked ${distinct.size} distinct rungs ` +
			`(${settled.join(' -> ')}), ${seen.stats.transitions} transitions, up to ${peakDissolve} cross-fades in one frame`)
	} finally { await browser?.close(); await stopChild(preview.server) }
}
