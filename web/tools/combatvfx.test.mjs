// STEELSEED — combat VFX logic (vfx.md M4, the cannon slice): the pieces a still frame cannot
// prove, exercised on the production modules.
//
//   - A particle spawned from a weapon event survives its first update. Birth times are
//     float32 and the event drain spawns before the pool updates; `age < 0` used to delete
//     about half of them on their first frame.
//   - Only `ultra` and `ultra-max` get the added combat layers.
//   - Impacts are sized by the weapon's authored envelope, not by raw damage.
//   - A model with fewer sockets than the rules have barrels gets one per barrel, at the rules'
//     lateral offsets (3TNK); a model that authors its own keeps them (4TNK).
//   - A cannon round in the snapshot is published as a shell streak on its authoritative
//     position, and its shot is marked flown so the impact replays no muzzle-to-impact line.
//   - A medic's heal and a mechanic's repair land as a restrained cue on Ultra and Ultra+, and
//     never as a hit (no burst, flash or tracer) on any preset.
//   - A nuclear strike follows its weapon's own rules: the dust front reaches each damage ring
//     at the tick its warhead lands, the flash is capped across overlapping strikes, water gets
//     foam and steam instead of a scorch, and a replay draws the same strike.
//   - The Ultra governor thins decorative density fast under load and gives it back slowly,
//     within a floor, and never runs on Ultra+ or the legacy presets.
//   - A strike in the shallows (RA's River) throws wet mud, not a water column; one beside a tree
//     throws splinters; a small arm throws its case on Ultra only (vfx.md Epic 5).
//   - A GPS satellite rises and a sonar pulse rings the water, both only where the viewer sees;
//     a parabomb falls under its chute (vfx.md Epic 7).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const WEB = resolve(import.meta.dirname, '..')
let temp, mod
before(async () => {
	temp = mkdtempSync(join(tmpdir(), 'steelseed-combatvfx-'))
	const outfile = join(temp, 'combat.mjs')
	await build({
		stdin: {
			contents: [
				"export { SoftParticles } from './src/fx/particles.ts'",
				"export { vfxBudgetFor } from './src/fx/vfx-budget.ts'",
				"export { impactSizeOf } from './src/fx/weapon-fx.ts'",
				"export { lookupRaWeaponVisual } from './src/fx/weapon-visuals.ts'",
				"export { withRulesBarrels, PRESENTATION_BINDINGS } from './src/units/attachments.ts'",
				"export { Projectiles } from './src/fx/projectiles.ts'",
				"export { Fx } from './src/fx/index.ts'",
				"export { EventBus, SimEvent } from './src/core/events.ts'",
				"export { NuclearStrike, ATOMIC, MINI_NUKE, FLASH_PEAK, MAX_STRIKES, flashAt } from './src/fx/nuclear-strike.ts'",
				"export { VfxGovernor, MIN_SCALE, OVER_MS, UNDER_MS } from './src/fx/vfx-governor.ts'",
				"export { ParachuteCanopies } from './src/fx/parachutes.ts'",
				"export { RotorDownwash, DOWNWASH_M } from './src/fx/rotor-downwash.ts'",
				"export { HeatSources, HEAT_FLOATS, MAX_HEAT } from './src/render/heat.ts'",
				"export { heatAt, HEAT_S } from './src/fx/nuclear-strike.ts'",
				"export { m4 } from './src/core/math.ts'",
				"export { NavalWakes, wakeDepthScale, DEEP_M } from './src/fx/naval-wakes.ts'",
				"export { spawnBuildingMaterial, MATERIAL_OF } from './src/fx/building-materials.ts'",
			].join('\n'),
			resolveDir: WEB, loader: 'ts',
		},
		bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
		// fx/index reads the forge manifests through Vite; an empty registry is enough here.
		define: { 'import.meta.glob': '__gateGlob' }, banner: { js: 'const __gateGlob = () => ({});' },
	})
	mod = await import(pathToFileURL(outfile))
})
after(() => { if (temp) rmSync(temp, { recursive: true, force: true }) })

const visible = { unmodelled: false, isVisible: () => true }
const render = { particles: 0, addParticle() { this.particles++ }, addLight() {}, submit() {}, upload: () => ({ indexCount: 1 }), camera: { position: new Float32Array(3) } }

test('a particle spawned before the pool updates survives its first frame', () => {
	const particles = new mod.SoftParticles()
	particles.configure(3072)
	// Times whose float32 rounding goes UP, which is what deleted them. Each is seconds after the
	// last, so the previous burst (1.1 s of gas) has expired and only the new one is alive.
	for (const time of [3.3, 7.7, 14.88, 101.1]) {
		particles.spawn('muzzlegas', 10.5, 1, 10.5, time, 42, 1, visible)
		particles.update(time, render, visible)
		assert.equal(particles.stats.alive, 4, `the four gas particles born at ${time} must survive their first update`)
	}
	// A real rewind (seconds) still clears them.
	particles.update(1, render, visible)
	assert.equal(particles.stats.alive, 0, 'a rewound clock must still clear the pool')
})

test('a directed burst leaves along its direction', () => {
	const particles = new mod.SoftParticles()
	particles.spawn('muzzlegas', 0, 0, 0, 5, 7, 1, visible, 1, 1, 0, 0, 0.2)
	const positions = []
	particles.update(5.5, { ...render, addParticle(x, y, z) { positions.push([x, y, z]) } }, visible)
	assert.ok(positions.length > 0)
	for (const [x, , z] of positions) assert.ok(x > 0.3 && Math.abs(z) < x, `gas went sideways: ${x.toFixed(2)}, ${z.toFixed(2)}`)
})

test('only ultra and ultra-max get the combat layers', () => {
	assert.equal(mod.vfxBudgetFor('ultra').combatLayers, true)
	assert.equal(mod.vfxBudgetFor('ultra-max').tier, 'ultra-plus')
	for (const q of ['low', 'medium', 'high', 'turbo', 'classic', '']) assert.equal(mod.vfxBudgetFor(q).combatLayers, false, q)
	assert.ok(mod.vfxBudgetFor('ultra-max').particleCapacity <= 4096, 'no tier may exceed the renderer particle limit')
})

test('impacts are sized by the authored weapon, not by damage', () => {
	const size = name => mod.impactSizeOf(mod.lookupRaWeaponVisual(name))
	assert.ok(size('25mm') < size('90mm') && size('90mm') < size('105mm') && size('105mm') < size('155mm'), 'guns grow with their envelope')
	assert.equal(Number(size('105mm').toFixed(3)), 1, '105mm is the reference')
	assert.ok(size('Pistol') < 0.2, 'a pistol round is small')
	assert.ok(size('SCUD') > size('Dragon'), 'a V2 warhead outweighs an anti-tank missile')
	for (const name of ['8Inch', 'ParaBomb', 'Grenade', 'TorpTube', 'TeslaZap', 'Flamer']) assert.ok(size(name) > 0 && size(name) <= 1.8, name)
})

test('a model with fewer sockets than barrels gets one per barrel at the rules offsets', () => {
	const heavy = mod.withRulesBarrels('3tnk', mod.PRESENTATION_BINDINGS['3tnk'])
	const gun = heavy.armaments.find(a => a.weapon === '105mm')
	assert.equal(gun.sockets.length, 2)
	assert.deepEqual(gun.barrels, [[0], [1]])
	assert.deepEqual(gun.sockets.map(s => Number(s.position[2].toFixed(4))), [0.083, -0.083])
	const mammoth = mod.PRESENTATION_BINDINGS['4tnk']
	assert.equal(mod.withRulesBarrels('4tnk', mammoth), mammoth, 'authored per-barrel sockets are kept')
	const light = mod.PRESENTATION_BINDINGS['1tnk']
	assert.equal(mod.withRulesBarrels('1tnk', light), light, 'a single barrel is untouched')
})

test('a cannon round in flight is a shell streak, and its shot is marked flown', () => {
	const projectiles = new mod.Projectiles()
	projectiles.init(render)
	// One 105mm flight bound to shot 9 of actor 5's armament 0, barrel 1.
	const names = ['105mm']
	const view = {
		count: 1, id: Uint32Array.of(77), sourceActorId: Uint32Array.of(5), typeId: Uint16Array.of(0), kind: Uint8Array.of(0),
		posX: Int32Array.of(10 * 1024), posY: Int32Array.of(12 * 1024), posZ: Int32Array.of(512),
		velX: Int32Array.of(682), velY: Int32Array.of(0), velZ: Int32Array.of(0), remainingTicks: Uint16Array.of(6),
		launchShot: Uint32Array.of(9), launchArmament: Uint16Array.of(0), launchBarrel: Uint16Array.of(1),
	}
	const ctx = { snapshot: { projectiles: view }, actorTypeName: i => names[i] ?? '' }
	projectiles.recordLaunch(5, 0, 1, 9, 9.2, 0.5, 12, 9.25, 0.6, 12.05, 1)
	assert.equal(projectiles.wasFlown(5, 0, 9), false, 'nothing has flown yet')
	const particles = new mod.SoftParticles()
	projectiles.update(1 / 60, 1.04, 0.5, ctx, render, visible, null, null, particles, true)
	assert.equal(projectiles.shells.count, 1, 'the round is published as a shell')
	assert.ok(Math.abs(projectiles.shells.dx[0] - 1) < 1e-6, 'the streak points along the authoritative velocity')
	assert.ok(projectiles.shells.speed[0] > 0.6 && projectiles.shells.speed[0] < 0.7, '105mm moves about 0.67 m per tick')
	assert.equal(projectiles.stats.bodiesDrawn, 0, 'a shell has no body')
	assert.equal(projectiles.wasFlown(5, 0, 9), true, 'its impact must not replay a line')
	assert.equal(projectiles.wasFlown(5, 0, 10), false, 'another shot is not flown')
})

test('a heal or a repair is a restrained cue on Ultra, and never a hit', () => {
	for (const [quality, weapon, cue] of [['ultra', 'Heal', 1], ['ultra-max', 'Repair', 1], ['high', 'Heal', 0]]) {
		const names = ['', weapon]
		// The 34-byte impact the emitter writes for a medic's heal: OpenRA sends it with damage 0.
		const view = new DataView(new ArrayBuffer(34))
		view.setInt32(0, 10 * 1024, true); view.setInt32(4, 12 * 1024, true); view.setInt32(8, 0, true)
		view.setInt16(16, 32767, true)
		view.setUint16(20, 0, true); view.setUint16(22, 1, true)
		view.setUint32(24, 5, true); view.setUint16(28, 0, true); view.setUint32(30, 9, true)
		const events = new mod.EventBus(), particles = [], draws = []
		const render = { camera: { position: Float32Array.of(10, 24, 12) }, upload: (mesh, label) => ({ indexCount: mesh.triangleCount * 3, label }),
			submit(item) { if (item.instanceCount) draws.push(item.mesh.label) }, addLight() {}, addParticle(...args) { particles.push(args) } }
		const shroud = { isVisible: () => true, unmodelled: false }
		const units = { muzzleLiftOf: () => 0, deathKindOf: () => 0, deathAltitudeOf: () => null, drainRungTransitions() {} }
		const ctx = { config: { q: { name: quality, decals: 512 } }, snapshot: { view, byteLength: 34, tick: 3 }, events, time: { tick: 3, alpha: 0 },
			actorTypeName: i => names[i] ?? '', peek: () => null, get: name => ({ render, terrain: { heightAt: () => 0 }, shroud, units })[name] }
		const fx = new mod.Fx()
		fx.init(ctx)
		events.emit(mod.SimEvent.projectileImpact, { kind: 2, offset: 0, byteLength: 34 })
		ctx.time.alpha = 0.5
		fx.update(1 / 60, ctx)
		const label = `${weapon} on ${quality}`
		assert.equal(fx.stats.acceptedImpactEvents, 1, label)
		assert.equal(fx.stats.mendImpacts, 1, label)
		assert.equal(fx.stats.unpairedImpacts + fx.stats.startedTracers, 0, `${label}: a mend is not a hit`)
		assert.equal(fx.stats.impactVocabularySpawns, cue, `${label}: only Ultra and Ultra+ draw the cue`)
		assert.equal(particles.length > 0, cue > 0, `${label}: particles drawn ${particles.length}`)
		assert.deepEqual(draws.filter(d => /impact|spark|flash|tracer/.test(d ?? '')), [], `${label}: no strike geometry`)
		fx.dispose()
	}
})

/** One weapon's warheads from the shipped rules yaml: `[{ type, spread (cells), delay }]`. */
function warheadsOf(file, weapon) {
	const text = readFileSync(resolve(WEB, '../engine/openra/mods/ra/weapons', file), 'utf8')
	const block = text.split(/\n(?=\S)/).find(b => b.startsWith(`${weapon}:`))
	assert.ok(block, `${weapon} in ${file}`)
	return block.split(/\n\tWarhead@/).slice(1).map(w => ({
		type: w.split('\n')[0].split(':')[1].trim(),
		spread: Number((/\n\t\tSpread: (\d+)c0/.exec(w) ?? [])[1] ?? NaN),
		delay: Number((/\n\t\tDelay: (\d+)/.exec(w) ?? [])[1] ?? 0),
		duration: Number((/\n\t\tDuration: (\d+)/.exec(w) ?? [])[1] ?? NaN),
	}))
}

test('the nuclear profiles are the Atomic and MiniNuke warheads', () => {
	for (const [file, weapon, profile] of [['superweapons.yaml', 'Atomic', mod.ATOMIC], ['explosions.yaml', 'MiniNuke', mod.MINI_NUKE]]) {
		const heads = warheadsOf(file, weapon)
		const rings = heads.filter(h => h.type === 'SpreadDamage')
		assert.deepEqual(rings.map(h => h.spread), rings.map((_, k) => k + 1), `${weapon}: one damage ring per 1c0`)
		assert.equal(rings.length, profile.rings, `${weapon} rings`)
		assert.deepEqual(rings.map(h => h.delay), rings.map((_, k) => k * profile.ringDelayTicks), `${weapon} ring delays`)
		assert.equal(heads.find(h => h.type === 'FlashEffect')?.duration, profile.flashTicks, `${weapon} flash`)
	}
})

function strikeRecorder() {
	const spawns = [], lights = [], stamps = []
	return {
		spawns, lights, stamps,
		particles: { spawn: (name, x, y, z, time, seed, scale) => spawns.push({ name, x, z, time, seed, scale }) },
		render: { addLight: (x, y, z, r, g, b, intensity, radius) => lights.push({ intensity, radius }) },
		scorch: { stamp: (x, z, size, seed, time, shroud, life) => stamps.push({ x, z, size, life }) },
	}
}
const open = { isVisible: () => true }

test('the dust front reaches each damage ring at the tick its warhead lands', () => {
	const strike = new mod.NuclearStrike(), rec = strikeRecorder()
	assert.equal(strike.strike(50, 2, 60, 10, 12345, mod.ATOMIC, false, 1, open), true)
	for (let frame = 0; frame <= 60; frame++) {
		const t = 10 + frame / 60
		const before = rec.spawns.length
		strike.tick(t, rec.particles, rec.render, rec.scorch, open)
		// Ring k's puffs are sized 1.8 + 0.3k; the disturbance under ground zero is 1.6.
		for (const p of rec.spawns.slice(before).filter(p => p.name === 'dustfront' && p.scale > 1.7)) {
			const k = Math.round((p.scale - 1.8) / 0.3), r = Math.hypot(p.x - 50, p.z - 60)
			assert.ok(r >= 0.85 * (k + 1) - 1e-6 && r <= 1.12 * (k + 1) + 1e-6, `ring ${k + 1}c0 puff at ${r.toFixed(2)} m`)
			assert.ok(t - 10 >= k * 0.2 - 1e-9, `ring ${k + 1}c0 drawn at ${(t - 10).toFixed(3)} s, before its warhead`)
		}
	}
	const radii = rec.spawns.filter(p => p.name === 'dustfront' && p.scale > 1.7).map(p => Math.hypot(p.x - 50, p.z - 60))
	assert.ok(Math.max(...radii) <= 5 * 1.12 + 1e-6 && Math.max(...radii) > 4.2, `outer front ${Math.max(...radii).toFixed(2)} m (Atomic reach 5c0)`)
	assert.equal(rec.stamps.length, 15, 'the burnt ground is scorched once the last ring lands')
	assert.ok(rec.stamps.every(s => s.life === mod.ATOMIC.aftermathS))
	// The aftermath runs on, then ends.
	for (let t = 11; t < 10 + mod.ATOMIC.aftermathS + 1; t += 0.5) strike.tick(t, rec.particles, rec.render, rec.scorch, open)
	assert.ok(rec.spawns.some(p => p.name === 'nukeember') && rec.spawns.some(p => p.name === 'coolsmoke'))
	assert.equal(strike.stats.active, 0, 'a strike ends when its aftermath does')
})

test('the flash is one capped light, shared by overlapping strikes', () => {
	assert.equal(mod.flashAt(0.05, 0.8), 1)
	assert.ok(mod.flashAt(0.79, 0.8) < 0.05 && mod.flashAt(0.8, 0.8) === 0)
	const strike = new mod.NuclearStrike(), rec = strikeRecorder()
	strike.strike(10, 0, 10, 5, 1, mod.ATOMIC, false, 1, open)
	strike.strike(30, 0, 30, 5, 2, mod.MINI_NUKE, false, 1, open)
	strike.strike(50, 0, 50, 5, 3, mod.ATOMIC, false, 1, open)
	assert.equal(strike.strike(70, 0, 70, 5, 4, mod.ATOMIC, false, 1, open), false, `only ${mod.MAX_STRIKES} strikes at once`)
	assert.equal(strike.stats.refused, 1)
	let peak = 0
	for (let t = 5; t < 6; t += 1 / 60) {
		rec.lights.length = 0
		strike.tick(t, rec.particles, rec.render, rec.scorch, open)
		const sum = rec.lights.reduce((a, l) => a + l.intensity, 0)
		assert.ok(sum <= mod.FLASH_PEAK + 1e-6, `three detonations together light ${sum.toFixed(2)}, over the cap`)
		peak = Math.max(peak, sum)
	}
	assert.ok(peak > mod.FLASH_PEAK * 0.9, 'the cap is reached, not undershot')
	assert.ok(strike.stats.lightPeak <= mod.FLASH_PEAK + 1e-6)
})

test('every nuclear detonation is drawn, even in the same second; only a replayed record is not', () => {
	// Three Demo Trucks die in an Atomic and each fires its MiniNuke (vfx.md S13). Records are the
	// emitter's 34-byte impacts: position (1/1024 m), up normal, damage, weapon type.
	const names = ['', 'Atomic', 'MiniNuke']
	const records = list => {
		const view = new DataView(new ArrayBuffer(34 * list.length))
		list.forEach(([type, x, z], k) => {
			const off = 34 * k
			view.setInt32(off, x * 1024, true); view.setInt32(off + 4, z * 1024, true); view.setInt16(off + 16, 32767, true)
			view.setUint16(off + 20, 15000, true); view.setUint16(off + 22, type, true); view.setUint32(off + 24, 5 + k, true); view.setUint32(off + 30, 9 + k, true)
		})
		return view
	}
	const events = new mod.EventBus()
	const shroud = { isVisible: () => true, unmodelled: false }
	const units = { muzzleLiftOf: () => 0, deathKindOf: () => 0, deathAltitudeOf: () => null, drainRungTransitions() {} }
	const render = { camera: { position: Float32Array.of(20, 24, 20) }, upload: (mesh, label) => ({ indexCount: mesh.triangleCount * 3, label }),
		submit() {}, addLight() {}, addParticle() {} }
	const ctx = { config: { q: { name: 'ultra', decals: 512 } }, snapshot: null, events, time: { tick: 3, alpha: 0 },
		actorTypeName: i => names[i] ?? '', peek: () => null, get: name => ({ render, terrain: { heightAt: () => 0 }, shroud, units })[name] }
	const fx = new mod.Fx()
	fx.init(ctx)
	const land = (tick, list) => {
		const view = records(list)
		ctx.snapshot = { view, byteLength: view.byteLength, tick }
		ctx.time.tick = tick
		list.forEach((_, k) => events.emit(mod.SimEvent.projectileImpact, { kind: 2, offset: 34 * k, byteLength: 34 }))
		fx.update(1 / 60, ctx)
	}
	// The Atomic, a truck 2 m out, a truck at ground zero, and the first truck's record again.
	land(3, [[1, 20, 20], [2, 22, 20], [2, 20, 20], [2, 22, 20]])
	assert.equal(fx.stats.acceptedImpactEvents, 4)
	assert.equal(fx.nuclearStats.started, 3, 'the Atomic and both MiniNukes start their strikes')
	assert.equal(fx.nuclearStats.refused, 0, 'the replayed record is dropped, not refused')
	assert.equal(fx.mushroom.stats.started, 1, 'the trucks under the Atomic\'s cap are drawn by its cloud')
	// Half a second later, a truck far away: its own cloud, though three strikes still burn.
	land(15, [[2, 60, 20]])
	assert.equal(fx.mushroom.stats.started, 2, 'a detonation elsewhere gets its own cloud')
	assert.equal(fx.nuclearStats.refused, 1, `only ${mod.MAX_STRIKES} staged strikes at once; the fourth is counted`)
	fx.dispose()
})

test('a strike over water gets foam and steam, and leaves no scorch or embers', () => {
	const strike = new mod.NuclearStrike(), rec = strikeRecorder()
	strike.strike(20, 0, 20, 0, 77, mod.MINI_NUKE, true, 1, open)
	for (let t = 0; t < 30; t += 0.25) strike.tick(t, rec.particles, rec.render, rec.scorch, open)
	const names = new Set(rec.spawns.map(p => p.name))
	assert.ok(names.has('foam') && names.has('steam') && names.has('splashcolumn'), [...names].join(','))
	assert.ok(!names.has('dustfront') && !names.has('nukeember') && !names.has('coolsmoke'), [...names].join(','))
	assert.equal(rec.stamps.length, 0)
})

test('a replay draws the same strike, and fog hides it', () => {
	const run = () => {
		const strike = new mod.NuclearStrike(), rec = strikeRecorder()
		strike.strike(40, 1, 40, 3, 424242, mod.ATOMIC, false, 1.5, open)
		for (let t = 3; t < 20; t += 1 / 30) strike.tick(t, rec.particles, rec.render, rec.scorch, open)
		return JSON.stringify([rec.spawns, rec.stamps])
	}
	assert.equal(run(), run())
	const strike = new mod.NuclearStrike(), rec = strikeRecorder()
	assert.equal(strike.strike(40, 1, 40, 3, 1, mod.ATOMIC, false, 1, { isVisible: () => false }), false)
	strike.tick(3.5, rec.particles, rec.render, rec.scorch, open)
	assert.equal(rec.spawns.length + rec.lights.length + rec.stamps.length, 0)
})

test('the Ultra governor: fast down, slow up, a floor, and only on Ultra', () => {
	assert.equal(mod.vfxBudgetFor('ultra').governed, true)
	for (const q of ['ultra-max', 'high', 'low', '']) assert.equal(mod.vfxBudgetFor(q).governed, false, q)
	assert.deepEqual(['ultra', 'ultra-max', 'high'].map(q => mod.vfxBudgetFor(q).lightCapacity), [32, 48, Infinity])
	const g = new mod.VfxGovernor()
	for (let i = 0; i < 600; i++) assert.equal(g.update(40, false), 1, 'an ungoverned tier is never thinned')
	// Overloaded: 30 ms frames. The first reduction lands within a second, and it never goes under the floor.
	let first = -1
	for (let i = 0; i < 600; i++) { g.update(30, true); if (first < 0 && g.scale < 1) first = i }
	assert.ok(first > 0 && first < 60, `first reduction after ${first} frames`)
	assert.equal(g.scale, mod.MIN_SCALE)
	// The dead band holds: frames between the two thresholds change nothing.
	const held = g.scale
	for (let i = 0; i < 1200; i++) g.update((mod.OVER_MS + mod.UNDER_MS) / 2, true)
	assert.equal(g.scale, held, 'no hunting between the thresholds')
	// Room again: recovery is slow, a twentieth every few seconds.
	let frames = 0
	while (g.scale < 1 && frames < 20000) { g.update(8, true); frames++ }
	assert.equal(g.scale, 1)
	assert.ok(frames > 60 * 20, `recovered in ${frames} frames; recovery must be much slower than reduction`)
	// A stall is not load.
	const before = g.scale
	for (let i = 0; i < 100; i++) g.update(900, true)
	assert.equal(g.scale, before)
	// Leaving Ultra resets it.
	g.update(30, true); g.update(30, false)
	assert.equal(g.scale, 1)
})

/** One 34-byte impact of `weapon` through production Fx at `quality`; returns its stats. */
function impactThroughFx(quality, weapon, damage) {
	const names = ['', weapon]
	const view = new DataView(new ArrayBuffer(34))
	view.setInt32(0, 10 * 1024, true); view.setInt32(4, 12 * 1024, true); view.setInt16(16, 32767, true)
	view.setUint16(20, damage, true); view.setUint16(22, 1, true); view.setUint32(24, 5, true); view.setUint32(30, 9, true)
	const events = new mod.EventBus(), particles = []
	const render = { camera: { position: Float32Array.of(10, 24, 12) }, upload: (mesh, label) => ({ indexCount: mesh.triangleCount * 3, label }),
		submit() {}, addLight() {}, addParticle(...args) { particles.push(args) } }
	const shroud = { isVisible: () => true, unmodelled: false }
	const units = { muzzleLiftOf: () => 0, deathKindOf: () => 0, deathAltitudeOf: () => null, drainRungTransitions() {} }
	const ctx = { config: { q: { name: quality, decals: 512 } }, snapshot: { view, byteLength: 34, tick: 3 }, events, time: { tick: 3, alpha: 0 },
		actorTypeName: i => names[i] ?? '', peek: () => null, get: name => ({ render, terrain: { heightAt: () => 0 }, shroud, units })[name] }
	const fx = new mod.Fx()
	fx.init(ctx)
	events.emit(mod.SimEvent.projectileImpact, { kind: 2, offset: 0, byteLength: 34 })
	ctx.time.alpha = 0.5
	fx.update(1 / 60, ctx)
	const stats = { ...fx.stats, particles: particles.length, scorch: fx.scorchStats.active }
	fx.dispose()
	return stats
}

test('a MAD thump is a seismic pulse on Ultra, and the detonation craters the ground', () => {
	const thump = impactThroughFx('ultra', 'MADTankThump', 1)
	assert.ok(thump.impactVocabularySpawns >= 30, `the thump's rings (${thump.impactVocabularySpawns})`)
	assert.equal(thump.scorch, 0, 'a thump leaves no crater')
	const blast = impactThroughFx('ultra-max', 'MADTankDetonate', 19)
	assert.ok(blast.impactVocabularySpawns > thump.impactVocabularySpawns, 'the detonation is the denser pulse')
	assert.ok(blast.scorch >= 9, `the detonation craters its ring (${blast.scorch} marks)`)
	const legacy = impactThroughFx('high', 'MADTankThump', 1)
	assert.equal(legacy.impactVocabularySpawns, 0, 'High keeps the generic burst')
})

/**
 * One 34-byte impact of `weapon` through production Fx at `quality`, on `surface`, with the given
 * snapshot actors (typeId per actor) and armour per type; returns its stats.
 */
function strikeThroughFx(quality, weapon, damage, surface, actors = [], materials = {}) {
	const names = ['', weapon, 't01', 'e1']
	const view = new DataView(new ArrayBuffer(34))
	view.setInt32(0, 10 * 1024, true); view.setInt32(4, 12 * 1024, true); view.setInt16(16, 32767, true)
	view.setUint8(18, surface)
	view.setUint16(20, damage, true); view.setUint16(22, 1, true); view.setUint32(24, 5, true); view.setUint32(30, 9, true)
	const events = new mod.EventBus(), particles = []
	const render = { camera: { position: Float32Array.of(10, 24, 12) }, upload: (mesh, label) => ({ indexCount: mesh.triangleCount * 3, label }),
		submit() {}, addLight() {}, addParticle(...args) { particles.push(args) } }
	const shroud = { isVisible: () => true, unmodelled: false }
	const units = { muzzleLiftOf: () => 0, deathKindOf: () => 0, deathAltitudeOf: () => null, drainRungTransitions() {},
		materialOf: typeId => materials[names[typeId]] ?? '' }
	const snapActors = { count: actors.length, id: Uint32Array.from(actors.map((_, i) => 100 + i)), typeId: Uint16Array.from(actors.map(a => a.type)),
		posX: Int32Array.from(actors.map(a => a.x)), posY: Int32Array.from(actors.map(a => a.y)), owner: new Uint8Array(actors.length),
		flags: new Uint8Array(actors.length), health: new Uint16Array(actors.length).fill(100) }
	const ctx = { config: { q: { name: quality, decals: 512 } }, snapshot: { view, byteLength: 34, tick: 3, actors: snapActors }, events, time: { tick: 3, alpha: 0 },
		actorTypeName: i => names[i] ?? '', peek: () => null, get: name => ({ render, terrain: { heightAt: () => 0 }, shroud, units })[name] }
	const fx = new mod.Fx()
	fx.init(ctx)
	events.emit(mod.SimEvent.projectileImpact, { kind: 2, offset: 0, byteLength: 34 })
	ctx.time.alpha = 0.5
	fx.update(1 / 60, ctx)
	const stats = { ...fx.stats, particles: particles.length }
	fx.dispose()
	return stats
}

test('a strike in the shallows throws wet mud, not a water column', () => {
	const SHALLOW = 9, WATER = 8
	const river = strikeThroughFx('ultra', '105mm', 60, SHALLOW)
	assert.equal(river.mudStrikes, 1, 'a shell in the River throws mud')
	assert.ok(river.impactVocabularySpawns >= 3, `mud spray, clods and a low mist (${river.impactVocabularySpawns})`)
	const sea = strikeThroughFx('ultra', '105mm', 60, WATER)
	assert.equal(sea.mudStrikes, 0, 'open water keeps its column')
	const legacy = strikeThroughFx('high', '105mm', 60, SHALLOW)
	assert.equal(legacy.mudStrikes, 0, 'High keeps the generic burst')
})

test('a strike beside a tree throws splinters, and one in the open does not', () => {
	const SOIL = 0
	const tree = { type: 2, x: 10 * 1024 + 300, y: 12 * 1024 - 200 }
	const woods = strikeThroughFx('ultra', '105mm', 60, SOIL, [tree], { t01: 'tree' })
	assert.equal(woods.woodStrikes, 1, 'a tree on the struck spot splinters')
	const open = strikeThroughFx('ultra', '105mm', 60, SOIL, [{ ...tree, x: 16 * 1024 }], { t01: 'tree' })
	assert.equal(open.woodStrikes, 0, 'a tree six metres off does not')
	const soldier = strikeThroughFx('ultra', '105mm', 60, SOIL, [{ type: 3, x: tree.x, y: tree.y }], { e1: 'none' })
	assert.equal(soldier.woodStrikes, 0, 'a soldier is no wood')
	assert.ok(woods.impactVocabularySpawns > open.impactVocabularySpawns, 'the splinters come on top of the ground debris')
})

/** One 24-byte fire of `weapon` by actor 5 through production Fx at `quality`; returns its stats. */
function fireThroughFx(quality, weapon, facing = 256) {
	const view = new DataView(new ArrayBuffer(24))
	view.setUint32(0, 5, true); view.setUint16(4, 0, true)
	view.setInt32(6, 10 * 1024, true); view.setInt32(10, 12 * 1024, true); view.setInt32(14, 256, true)
	view.setUint16(18, facing, true); view.setUint16(20, 0, true); view.setUint16(22, 8, true)
	const events = new mod.EventBus(), particles = []
	const render = { camera: { position: Float32Array.of(10, 24, 12) }, upload: (mesh, label) => ({ indexCount: mesh.triangleCount * 3, label }),
		submit() {}, addLight() {}, addParticle(...args) { particles.push(args) } }
	const shroud = { isVisible: () => true, unmodelled: false }
	const units = { muzzleLiftOf: () => 0, deathKindOf: () => 0, deathAltitudeOf: () => null, drainRungTransitions() {}, weaponNameOf: () => weapon }
	const ctx = { config: { q: { name: quality, decals: 512 } }, snapshot: { view, byteLength: 24, tick: 3 }, events, time: { tick: 3, alpha: 0 },
		actorTypeName: () => '', peek: () => null, get: name => ({ render, terrain: { heightAt: () => 0 }, shroud, units })[name] }
	const fx = new mod.Fx()
	fx.init(ctx)
	events.emit(mod.SimEvent.weaponFire, { kind: 1, offset: 0, byteLength: 24 })
	ctx.time.alpha = 0.5
	fx.update(1 / 60, ctx)
	const stats = { ...fx.stats }
	fx.dispose()
	return stats
}

test('a small arm throws its spent case on Ultra, and a cannon or a legacy preset does not', () => {
	assert.equal(fireThroughFx('ultra', 'M1Carbine').casings, 1, 'a rifle on Ultra')
	assert.equal(fireThroughFx('ultra-max', 'M60mg').casings, 1, 'a machine gun on Ultra+')
	assert.equal(fireThroughFx('ultra', '105mm').casings, 0, 'a cannon throws no case')
	assert.equal(fireThroughFx('high', 'M1Carbine').casings, 0, 'High is unchanged')
})

test('a GPS satellite rises and a sonar pulse rings the water, only where the viewer sees', () => {
	for (const seen of [true, false]) {
		const particles = [], lights = []
		const render = { camera: { position: Float32Array.of(10, 24, 12) }, upload: (mesh, label) => ({ indexCount: mesh.triangleCount * 3, label }),
			submit() {}, addLight(...args) { lights.push(args) }, addParticle(...args) { particles.push(args) } }
		const shroud = { isVisible: () => seen, unmodelled: false }
		const units = { muzzleLiftOf: () => 0, deathKindOf: () => 0, deathAltitudeOf: () => null, drainRungTransitions() {} }
		const ctx = { config: { q: { name: 'high', decals: 512 } }, snapshot: { tick: 3 }, events: new mod.EventBus(), time: { tick: 3, alpha: 0 },
			actorTypeName: () => '', peek: () => null, get: name => ({ render, terrain: { heightAt: () => 0, waterHeightAt: () => -0.2 }, shroud, units })[name] }
		const fx = new mod.Fx()
		fx.init(ctx)
		fx.supportEffect('satellite', 20.5, 30.5)
		fx.supportEffect('sonar', 40.5, 30.5, 1)
		// The effect clock runs on simulation ticks (25 a second): one tick a frame here.
		for (let f = 0; f < 90; f++) { ctx.time.tick = 3 + f; fx.update(1 / 25, ctx) }
		assert.equal(fx.stats.satelliteLaunches, 1)
		assert.equal(fx.stats.sonarPulses, 1)
		const heights = particles.filter(p => Math.abs(p[0] - 20.5) < 1).map(p => p[1])
		const rings = particles.filter(p => Math.abs(p[0] - 40.5) < 12 && Math.abs(p[1] + 0.15) < 0.3)
		if (seen) {
			assert.ok(heights.length > 0 && Math.max(...heights) > 3, `the satellite climbs (${Math.max(...heights, 0).toFixed(1)} m)`)
			assert.ok(rings.length > 0, 'the pulse rings the water')
			assert.ok(lights.length > 0, 'the exhaust lights the tech centre')
		} else {
			assert.equal(particles.length, 0, 'under fog nothing is drawn')
		}
		fx.dispose()
	}
})

test('a parabomb falls under its chute', () => {
	const projectiles = new mod.Projectiles()
	projectiles.init(render)
	const names = ['ParaBomb', 'M1Carbine']
	const view = {
		count: 1, id: Uint32Array.of(78), sourceActorId: Uint32Array.of(6), typeId: Uint16Array.of(0), kind: Uint8Array.of(0),
		posX: Int32Array.of(10 * 1024), posY: Int32Array.of(12 * 1024), posZ: Int32Array.of(4096),
		velX: Int32Array.of(0), velY: Int32Array.of(0), velZ: Int32Array.of(-50), remainingTicks: Uint16Array.of(60),
	}
	const ctx = { snapshot: { projectiles: view }, actorTypeName: i => names[i] ?? '' }
	projectiles.update(1 / 60, 1.04, 0.5, ctx, render, visible, null, null, new mod.SoftParticles(), false)
	assert.equal(projectiles.chutes.count, 1, 'the parabomb is published for its chute')
	assert.ok(projectiles.chutes.y[0] > 3.5, 'at its altitude')
	const draws = []
	const canopies = new mod.ParachuteCanopies()
	const stub = { upload: (mesh, label) => ({ indexCount: mesh.triangleCount * 3, label }), submit(item) { draws.push(item.instanceCount) } }
	const noActors = { count: 0, flags: new Uint8Array(0), id: new Uint32Array(0) }
	canopies.update({}, noActors, { selectionHeightM: () => 1, captureActorVisual: () => false }, stub, projectiles.chutes)
	assert.equal(canopies.stats.bombs, 1, 'one chute over the bomb')
	assert.deepEqual(draws, [1], 'drawn in the one canopy draw')
	view.typeId[0] = 1
	projectiles.update(1 / 60, 1.1, 0.5, ctx, render, visible, null, null, new mod.SoftParticles(), false)
	assert.equal(projectiles.chutes.count, 0, 'a bullet has no chute')
})

test('over its coverage budget the pool thins a stable share of smoke and dust, never fire', () => {
	const particles = new mod.SoftParticles()
	particles.configure(4096, 0.05)
	const eye = { camera: { position: Float32Array.of(10, 3, 10) } }
	// Dense smoke and a fire, close to the eye: far over a tiny budget.
	for (let k = 0; k < 8; k++) particles.spawn('smoke', 10.5 + k * 0.1, 1, 12, 5, 100 + k, 1, visible)
	particles.spawn('fire', 10.5, 1, 12, 5, 7, 1, visible)
	const drawn = frame => { const out = []; particles.update(frame, { ...render, ...eye, addParticle(...a) { out.push(a) } }, visible); return out }
	const first = drawn(5.2)
	assert.ok(particles.stats.coverage > 0.05, `coverage measured (${particles.stats.coverage.toFixed(3)})`)
	assert.equal(particles.stats.thinned, 0, 'the first frame has no measurement to act on')
	const second = drawn(5.25), third = drawn(5.3)
	assert.ok(particles.stats.thinned > 0, 'the next frames thin')
	const seeds = frame => frame.filter(p => p[10] < 0.5).map(p => p[9]).sort()
	assert.ok(second.length < first.length, `fewer drawn (${first.length} -> ${second.length})`)
	assert.deepEqual(seeds(second), seeds(third), 'the same particles stay hidden: no flicker')
	// Fire (emission 1) is never thinned.
	assert.equal(second.filter(p => p[10] >= 0.5).length, first.filter(p => p[10] >= 0.5).length, 'every fire particle still draws')
	// With no budget nothing is thinned.
	const open = new mod.SoftParticles()
	open.configure(4096)
	for (let k = 0; k < 8; k++) open.spawn('smoke', 10.5 + k * 0.1, 1, 12, 5, 100 + k, 1, visible)
	for (const t of [5.2, 5.25]) open.update(t, { ...render, ...eye }, visible)
	assert.equal(open.stats.thinned, 0)
})

test('a helicopter low over the ground blows up the surface; high, fogged or cloaked it does not', () => {
	const run = ({ clearance, water = false, seen = true, flags = 0 }) => {
		const wash = new mod.RotorDownwash(), spawned = []
		const particles = { spawn: (name, x, y, z) => spawned.push({ name, y }) }
		const matrix = new Float32Array(16)
		matrix[12] = 10.5; matrix[13] = (water ? -0.2 : 0) + clearance; matrix[14] = 12.5
		const units = { visitVisibleInstances: (slot, sink) => { if (slot === 'heli') sink(matrix, 0, 42) } }
		const actors = { count: 1, id: Uint32Array.of(42), health: Uint8Array.of(200), flags: Uint8Array.of(flags) }
		const ctx = { snapshot: { actors }, get: () => units }
		const terrain = { heightAt: () => 0, waterHeightAt: () => water ? -0.2 : null, surfaceAt: () => 0 }
		wash.tick(3, 1, ctx, particles, { isVisible: () => seen }, terrain)
		return { spawned, stats: { ...wash.stats } }
	}
	const low = run({ clearance: 1 })
	assert.ok(low.spawned.length >= 2 && low.spawned.every(p => p.name === 'dustskirt'), `dust under a low helicopter (${low.spawned.length})`)
	assert.equal(run({ clearance: mod.DOWNWASH_M + 1 }).spawned.length, 0, 'nothing when it flies high')
	const sea = run({ clearance: 0.8, water: true })
	assert.ok(sea.spawned.some(p => p.name === 'watermist') && sea.spawned.some(p => p.name === 'foam'), 'spray and foam over water')
	assert.equal(run({ clearance: 1, seen: false }).spawned.length, 0, 'fog hides it')
	assert.equal(run({ clearance: 1, flags: 2 }).spawned.length, 0, 'a cloaked rotorcraft blows nothing')
	// Legacy presets never get the layer: Fx ticks it only with the Ultra combat layers.
	assert.equal(mod.vfxBudgetFor('high').combatLayers, false)
})

/** A camera 30 m back and 30 m up from the origin, looking at it, 16:9 at 1920x1080. */
function testCamera() {
	const view = new Float32Array(16), proj = new Float32Array(16), viewProj = new Float32Array(16)
	mod.m4.lookAt(view, Float32Array.of(0, 30, 30), Float32Array.of(0, 0, 0), Float32Array.of(0, 1, 0))
	mod.m4.perspectiveReverseZ(proj, Math.PI / 4, 1920 / 1080, 0.1)
	return mod.m4.multiply(viewProj, proj, view)
}

test('heat sources project to framebuffer pixels, sized at their depth, four at most', () => {
	const heat = new mod.HeatSources(), out = new Float32Array(mod.HEAT_FLOATS), viewProj = testCamera()
	heat.add(0, 0, 0, 5, 3.5)
	assert.equal(heat.pack(viewProj, 1920, 1080, 12.5, out), 1)
	assert.ok(Math.abs(out[0] - 960) < 1 && Math.abs(out[1] - 540) < 1, `the focus is the screen centre: ${out[0]}, ${out[1]}`)
	assert.ok(out[2] > 20 && out[2] < 600, `a 5 m disc 42 m away spans ${out[2]} px`)
	assert.equal(out[3], 3.5)
	assert.equal(out[mod.MAX_HEAT * 4 + 1], 1, 'the count travels with the sources')
	// Nearer is larger.
	heat.reset(); heat.add(0, 20, 20, 5, 3.5); heat.pack(viewProj, 1920, 1080, 0, out)
	assert.ok(out[2] > 60, `nearer, the same disc spans more: ${out[2]} px`)
	// Behind the camera and far off screen: dropped.
	heat.reset(); heat.add(0, 40, 60, 5, 3); heat.add(900, 0, 0, 5, 3)
	assert.equal(heat.pack(viewProj, 1920, 1080, 0, out), 0)
	assert.equal(out[0], 0, 'unused slots are zeroed')
	// A fifth source is refused; reset empties the frame.
	heat.reset()
	for (let i = 0; i < 6; i++) heat.add(i - 3, 0, 0, 2, 2)
	assert.equal(heat.size, mod.MAX_HEAT)
	heat.reset()
	assert.equal(heat.size, 0)
})

test('the nuclear shimmer is Ultra+ only, restrained, follows the column and never shows under fog', () => {
	assert.equal(mod.heatAt(0), 0)
	assert.equal(mod.heatAt(1), 1)
	assert.ok(mod.heatAt(4) > 0 && mod.heatAt(4) < 1, 'it fades after its hold')
	assert.equal(mod.heatAt(mod.HEAT_S), 0)
	const run = (heat, fogged) => {
		const strike = new mod.NuclearStrike(), sources = []
		const lights = { addLight() {}, addHeatSource(x, y, z, r, s) { sources.push({ y, r, s }) } }
		const shroud = { unmodelled: false, isVisible: () => !fogged }
		const sink = { spawn() {} }
		// The strike itself needs sight of ground zero; the fog then closes over it.
		assert.ok(strike.strike(10, 1, 10, 100, 7, mod.ATOMIC, false, 1, { isVisible: () => true }, heat))
		for (const t of [100.5, 101.5, 103, 105.5, 107]) strike.tick(t, sink, lights, null, shroud)
		return sources
	}
	const ultraPlus = run(true, false)
	assert.equal(ultraPlus.length, 4, 'a shimmer each frame of its six seconds, none after')
	assert.ok(ultraPlus[1].y > ultraPlus[0].y && ultraPlus[1].r > ultraPlus[0].r, 'it rises and widens with the column')
	assert.ok(ultraPlus.every(s => s.s <= 3.5), 'restrained: never more than 3.5 px of bend')
	assert.equal(run(false, false).length, 0, 'Ultra keeps its strike without the shimmer')
	assert.equal(run(true, true).length, 0, 'no shimmer where the player cannot see')
})

test('a wake breaks up sooner and spreads wider over a shelving bottom', () => {
	assert.deepEqual(mod.wakeDepthScale(mod.DEEP_M), { life: 1, width: 1 })
	assert.deepEqual(mod.wakeDepthScale(5), { life: 1, width: 1 }, 'deeper than the open sea is the open sea')
	const shallow = mod.wakeDepthScale(0)
	assert.ok(shallow.life < 0.6 && shallow.width > 1.3, JSON.stringify(shallow))
	// A destroyer driving straight at half a metre a second, once over open sea and once over a
	// bed 0.2 m down: the same wake, shorter lived and wider in the shallows.
	const drive = bedDepth => {
		const plan = { waterlineY: 0, bow: { x: 0.6, leftZ: -0.12, rightZ: 0.12 }, stern: { x: -0.6, leftZ: -0.12, rightZ: 0.12 }, beam: 0.3, length: 1.6, lifetimeS: 3 }
		const wakes = new mod.NavalWakes(plan)
		const stub = { upload: () => ({}), submit() {}, addParticle() {}, camera: { position: new Float32Array(3) } }
		wakes.init(stub, 512)
		const ctx = { snapshot: { actors: { count: 1, id: Uint32Array.of(7), flags: Uint8Array.of(0), owner: Uint8Array.of(1) }, world: { renderPlayer: 1 } } }
		const terrain = { waterHeightAt: () => 0, heightAt: () => -bedDepth }
		const matrix = new Float32Array(16)
		for (let k = 0; k < 40; k++) {
			const t = k * 0.1
			matrix.fill(0); matrix[0] = 1; matrix[5] = 1; matrix[10] = 1; matrix[15] = 1; matrix[12] = 5 + t * 0.5; matrix[14] = 5
			const units = { visitVisibleInstances: (name, visit) => { if (name === 'dd') visit(matrix, 0, 7) } }
			wakes.tick(t, ctx, units, stub, terrain, visible)
		}
		const lives = [], widths = []
		for (let i = 0; i < wakes.records.length / 10; i++) if (wakes.alive[i]) { lives.push(wakes.records[i * 10 + 8]); widths.push(wakes.records[i * 10 + 7]) }
		return { n: lives.length, life: Math.max(...lives), width: widths.reduce((a, b) => a + b, 0) / widths.length, shallow: wakes.stats.shallow }
	}
	const open = drive(1.5), shelf = drive(0.2)
	assert.ok(open.n > 0 && shelf.n > 0, `wakes drawn: ${open.n} open, ${shelf.n} shallow`)
	assert.equal(open.shallow, 0, 'the open sea is not shallow')
	assert.ok(shelf.shallow > 0, 'the shelf counts as shallow')
	assert.ok(shelf.life < open.life * 0.75, `shorter lived: ${shelf.life.toFixed(2)} vs ${open.life.toFixed(2)} s`)
	assert.ok(shelf.width > open.width * 1.15, `wider: ${shelf.width.toFixed(3)} vs ${open.width.toFixed(3)} m`)
})

test('a building collapses in its own material, bounded, seeded and never unseen', () => {
	const run = (template, strength = 1, seen = true) => {
		const spawns = []
		const n = mod.spawnBuildingMaterial(template, 10, 0, 10, 4, 5, 20, 99, strength, 1, { spawn(name, x, y, z) { spawns.push({ name, x, y, z }) } }, { isVisible: () => seen })
		return { n, names: [...new Set(spawns.map(s => s.name))].sort(), spawns }
	}
	assert.deepEqual(run('power').names, ['teslacrawl', 'zapspark'], 'a power plant arcs')
	assert.deepEqual(run('refinery').names, ['fireball', 'soot'], 'a refinery burns fuel')
	assert.deepEqual(run('barracks').names, ['hazerock', 'rubble'], 'barracks shed masonry')
	assert.deepEqual(run('factory').names, ['frag', 'weldspark'], 'a factory tears metal')
	assert.equal(run('bridge').n, 0, 'no layer for a template that is not a building material')
	assert.equal(run('power', 1, false).n, 0, 'nothing where the player cannot see')
	assert.ok(run('power').n <= 12 && run('power', 0.45).n < run('power').n, 'bounded, and a crossing throws less than the collapse')
	assert.deepEqual(run('silo').spawns, run('silo').spawns, 'the same event draws the same layer')
	for (const s of run('yard').spawns) assert.ok(Math.hypot(s.x - 10, s.z - 10) <= 2.5 && s.y >= 0 && s.y <= 4, 'on the building, not beside it')
	// Every template the collapse knows has a material, so no structure dies without one.
	for (const t of ['yard', 'factory', 'power', 'refinery', 'silo', 'barracks', 'tent', 'kennel', 'radar', 'tech', 'depot', 'helipad', 'airfield',
		'dock', 'defense', 'coil', 'experimental', 'missile_silo', 'command', 'hospital', 'house', 'church', 'lighthouse', 'windmill', 'derrick'])
		assert.ok(mod.MATERIAL_OF[t], `${t} has no material`)
})

/** An MCV's deployment (the snapshot's deployments section) through the real Fx, frame by frame. */
function deployThroughFx(quality, frames) {
	const records = new DataView(new ArrayBuffer(32))
	records.setUint32(0, 77, true); records.setUint32(4, 76, true)
	records.setInt32(8, 20 * 1024, true); records.setInt32(12, 30 * 1024, true); records.setUint16(24, 32, true); records.setUint16(26, 1280, true)
	const events = new mod.EventBus(), particles = []
	const render = { camera: { position: Float32Array.of(20, 24, 30) }, upload: (mesh, label) => ({ indexCount: mesh.triangleCount * 3, label }),
		submit() {}, addLight() {}, addParticle(...args) { particles.push(args) } }
	const shroud = { isVisible: () => true, unmodelled: false }
	const units = { muzzleLiftOf: () => 0, deathKindOf: () => 0, deathAltitudeOf: () => null, drainRungTransitions() {} }
	const actors = { count: 0, id: new Uint32Array(0), typeId: new Uint16Array(0), posX: new Int32Array(0), posY: new Int32Array(0), owner: new Uint8Array(0), flags: new Uint8Array(0), health: new Uint16Array(0) }
	const ctx = { config: { q: { name: quality, decals: 512 } }, snapshot: { tick: 1, actors, deployments: { count: 1, byteOffset: 0, view: records } }, events, time: { tick: 1, alpha: 0 },
		actorTypeName: () => '', peek: () => null, get: name => ({ render, terrain: { heightAt: () => 0, surfaceAt: () => 0 }, shroud, units })[name] }
	const fx = new mod.Fx()
	fx.init(ctx)
	const dust = []
	for (const frame of frames) {
		records.setUint16(22, frame, true); ctx.snapshot.tick++; ctx.time.tick++
		fx.update(1 / 25, ctx)
		dust.push(fx.stats.deployDust)
	}
	fx.dispose()
	return dust
}

test('an MCV setting down raises stabilizer dust once, at the start, on Ultra only', () => {
	assert.deepEqual(deployThroughFx('ultra', [0, 4, 12, 31]), [1, 1, 1, 1], 'one ring as it starts to unpack, none after')
	assert.deepEqual(deployThroughFx('ultra', [20, 31]), [0, 0], 'a yard first seen half unpacked was not just set down')
	assert.deepEqual(deployThroughFx('high', [0, 4]), [0, 0], 'High keeps the shipped look')
})

/** Actors across two snapshots through the real Fx: counts heat sources and material layers. */
function actorsThroughFx(quality, rows, { moved = null, destroyed = null } = {}) {
	const names = ['', 'ctnk', 'mgg', 'mrj']
	const make = list => ({ count: list.length, id: Uint32Array.from(list.map(r => r.id)), typeId: Uint16Array.from(list.map(r => r.type)),
		posX: Int32Array.from(list.map(r => r.x)), posY: Int32Array.from(list.map(r => r.y)), posZ: new Int32Array(list.length), owner: Uint8Array.from(list.map(r => r.owner ?? 0)),
		flags: new Uint8Array(list.length), health: new Uint16Array(list.length).fill(200), facing: new Uint16Array(list.length) })
	const before = make(rows), after = make(rows.map(r => r.id === moved?.id ? { ...r, x: moved.x, y: moved.y } : r))
	const heat = [], events = new mod.EventBus()
	const view = new DataView(new ArrayBuffer(18))
	const render = { camera: { position: Float32Array.of(20, 24, 30) }, upload: (mesh, label) => ({ indexCount: mesh.triangleCount * 3, label }),
		submit() {}, addLight() {}, addParticle() {}, addHeatSource(...args) { heat.push(args) } }
	const shroud = { isVisible: () => true, unmodelled: false }
	const units = { muzzleLiftOf: () => 0, deathKindOf: () => 2, deathAltitudeOf: () => null, drainRungTransitions() {} }
	const players = [{ id: 0, relation: 0 }, { id: 1, relation: 2 }]
	const ctx = { config: { q: { name: quality, decals: 512 } }, prevSnapshot: { tick: 1, actors: before, world: { renderPlayer: 0 }, players },
		snapshot: { tick: 2, actors: after, world: { renderPlayer: 0 }, players, view, byteLength: 18 }, events, time: { tick: 2, alpha: 0 },
		actorTypeName: i => names[i] ?? '', peek: () => null, get: name => ({ render, terrain: { heightAt: () => 0, surfaceAt: () => 0 }, shroud, units })[name] }
	const fx = new mod.Fx()
	fx.init(ctx)
	if (destroyed) {
		view.setUint32(0, destroyed.id, true); view.setInt32(4, destroyed.x, true); view.setInt32(8, destroyed.y, true); view.setUint8(16, 2); view.setUint8(17, 200)
		events.emit(mod.SimEvent.actorDestroyed, { kind: 5, offset: 0, byteLength: 18 })
	}
	fx.update(1 / 25, ctx)
	const stats = { heat: heat.length, materialLayers: fx.stats.materialLayers, teleports: fx.stats.teleports }
	fx.dispose()
	return stats
}

test('a chronoshift bends both ends on Ultra+, and an own gap generator shimmers, an enemy one never', () => {
	const tank = { id: 5, type: 1, x: 10 * 1024, y: 10 * 1024 }
	const jumped = actorsThroughFx('ultra-max', [tank], { moved: { id: 5, x: 40 * 1024, y: 12 * 1024 } })
	assert.equal(jumped.teleports, 1)
	assert.equal(jumped.heat, 2, 'departure and arrival each shimmer')
	assert.equal(actorsThroughFx('ultra', [tank], { moved: { id: 5, x: 40 * 1024, y: 12 * 1024 } }).heat, 0, 'Ultra keeps its flashes only')
	const own = { id: 6, type: 2, x: 20 * 1024, y: 20 * 1024, owner: 0 }, enemy = { id: 7, type: 2, x: 30 * 1024, y: 20 * 1024, owner: 1 }
	assert.equal(actorsThroughFx('ultra-max', [own]).heat, 1, "our gap generator's field shimmers")
	assert.equal(actorsThroughFx('ultra-max', [enemy]).heat, 0, "an enemy's never")
})

test('the jammer dies as electrical hardware on Ultra', () => {
	const jammer = { id: 8, type: 3, x: 15 * 1024, y: 15 * 1024 }
	assert.equal(actorsThroughFx('ultra', [jammer], { destroyed: jammer }).materialLayers, 1, 'sparks and a crawl')
	assert.equal(actorsThroughFx('high', [jammer], { destroyed: jammer }).materialLayers, 0, 'High keeps the shipped death')
})

test('a flame packet lights a short contact fire where it lands, on Ultra only', () => {
	const SOIL = 0, METAL = 6
	assert.equal(strikeThroughFx('ultra', 'Flamer', 20, SOIL).contactFires, 1, 'the flamer lights the ground it lands on')
	assert.equal(strikeThroughFx('ultra', 'Flamer', 20, METAL).contactFires, 0, 'bare metal does not burn')
	assert.equal(strikeThroughFx('ultra', '105mm', 60, SOIL).contactFires, 0, 'a shell is not a flame')
	assert.equal(strikeThroughFx('high', 'Flamer', 20, SOIL).contactFires, 0, 'High keeps the shipped look')
})
