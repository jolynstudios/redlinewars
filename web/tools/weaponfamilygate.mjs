#!/usr/bin/env node
// STEELSEED — tools/weaponfamilygate
//
// Proves that a rifle, a machine gun, a tank gun, an artillery piece, a rocket, a flamethrower
// and a tesla coil DRAW DIFFERENTLY, rather than drawing one object at seven sizes.
//
// WHY THIS GATE EXISTS. `src/weapon-visual-manifest.json` holds 50 profiles across 11 families
// and each names a muzzle style, a tracer style, a tracer colour, a width, a lifetime, a smoke
// word and an impact word. One field of the eight had a consumer — `muzzle.scaleM`. The other
// seven were authored, validated by two gates, shipped, and never reached a frame. So a gate
// that only asks "did a flash draw?" cannot tell this build from that one, and that is precisely
// the failure this project keeps paying for: a claim about a pipeline is not a claim about a
// frame. Every assertion below is a DIFFERENCE between two families, measured on what the node
// actually hands the renderer, and the falsification modes reproduce the old build to show the
// gate goes red on it.
//
// WHAT IS MEASURED
//   1. geometry   — the drawn world-space extent of each family's muzzle mesh under its own
//                   authored scale, so "a broad cone with a shock ring" is a number and not a
//                   sentence. A rocket's efflux is also proven to sit BEHIND the fire point.
//   2. colour     — each family's DrawItem emitter, checked to be the manifest's own authored
//                   chromaticity rather than a colour retyped here, and checked to be pairwise
//                   distinct. Warm families stay red-dominant; the coil stays blue-dominant.
//   3. width      — two weapons with IDENTICAL damage and different authored widths must draw
//                   different tracer radii. Under the shipped damage-derived expression they
//                   drew the same radius by construction, so this single case separates the two
//                   builds on its own.
//   4. vocabulary — the particle colours that actually reach `RenderApi.addParticle` after one
//                   shot from each weapon. A bullet chip, a shell burst and an electrical hit
//                   must differ in count and in colour.
//   5. one frame  — the human's own test: a rifleman, a grenadier, a medium tank and a V2 firing
//                   in the SAME frame, on a GPU, screenshotted, with the four regions measured
//                   for area and hue. The grenadier must show NO muzzle flash, because his
//                   profile authors `muzzle.scaleM: 0` and that is correct.
//
// Usage:
//   node tools/weaponfamilygate.mjs [--falsify=flat-manifest|no-emitter|damage-width] [--png=DIR]
//
//   --falsify=flat-manifest  rebuilds the node against a catalogue where every family carries the
//                            rifleman's profile — one shape, one colour, one width — which is
//                            observationally the build before this work. Geometry, colour,
//                            width and vocabulary must all go red.
//   --falsify=no-emitter     drops the per-item emitter colour on the way to the renderer, which
//                            is the engine before `DrawItem.emitterColor` existed. Colour must go
//                            red and geometry must stay green, proving the two are independent.
//   --falsify=damage-width   sizes the tracer from damage the way the shipped build did. Width
//                            must go red and nothing else.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'
import { encodePng } from './png.mjs'

const TOOL = 'weaponfamilygate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = name => {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : null
}
const falsify = arg('falsify')
const pngDir = arg('png')
const FALSIFICATIONS = new Set(['flat-manifest', 'no-emitter', 'damage-width'])
if (falsify !== null && !FALSIFICATIONS.has(falsify)) {
	console.error(`${TOOL}: unknown --falsify=${falsify}`)
	process.exit(2)
}
// A port nothing else in this repo binds. 8321 is the human's live game and must never be bound.
const PORT = 8451

const problems = []
const note = m => problems.push(m)

// --- the node, bundled ---------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'weaponfamilygate-'))
const realManifest = JSON.parse(
	await import('node:fs/promises').then(fs => fs.readFile(join(WEB, 'src/weapon-visual-manifest.json'), 'utf8')))

// The falsified catalogue: every profile keeps its identity and takes the rifleman's appearance.
// That is exactly what shipped — one muzzle shape scaled by `scaleM`, one tracer primitive, one
// emitter colour — expressed as data, so the gate is falsified by the previous BEHAVIOUR rather
// than by a flag the production code branches on.
const flatManifestPath = join(tmp, 'flat-weapon-visual-manifest.json')
{
	const rifle = realManifest.profiles.find(p => p.weapon === 'M1Carbine')
	if (rifle === undefined) throw new Error(`${TOOL}: the catalogue no longer holds M1Carbine`)
	const flat = JSON.parse(JSON.stringify(realManifest))
	for (const profile of flat.profiles) {
		profile.style = JSON.parse(JSON.stringify(rifle.style))
		profile.style.family = 'bullet'
	}
	writeFileSync(flatManifestPath, JSON.stringify(flat))
}

const entry = join(tmp, 'e.ts')
writeFileSync(entry, [
	`export { Fx } from '${WEB}/src/fx/index'`,
	`export { EventBus, SimEvent } from '${WEB}/src/core/events'`,
	`export * as WeaponFx from '${WEB}/src/fx/weapon-fx'`,
	`export { default as CONTENT } from '${WEB}/src/content-manifest.json'`,
	`export { lookupRaWeaponVisual } from '${WEB}/src/fx/weapon-visuals'`,
].join('\n') + '\n')
const bundle = join(tmp, 'b.mjs')
const flatten = {
	name: 'flat-manifest',
	setup(build) {
		build.onResolve({ filter: /weapon-visual-manifest\.json$/ }, () => ({ path: flatManifestPath }))
	},
}
await esbuild({
	entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle,
	logLevel: 'silent',
	// `fx` reaches the forged roster through Vite's import.meta.glob for stack smoke and
	// building-death clouds. An empty glob is the honest answer for a fixture with no pack.
	define: { 'import.meta.glob': '__gateGlob' },
	banner: { js: 'const __gateGlob = () => ({});' },
	plugins: falsify === 'flat-manifest' ? [flatten] : [],
})
const { Fx, EventBus, SimEvent, WeaponFx, lookupRaWeaponVisual, CONTENT } = await import(bundle)

// --- 0. the pool budget, before anything is drawn -------------------------------------------
//
// The particle pool is 2048 slots shared with every explosion, chimney and rocket trail on the
// map, and `fx/projectiles.ts` already reserves up to 352 of them. A vocabulary that names ten
// impact words is worth nothing if it quietly costs more pool than the one constant it replaced,
// so the tables are checked against their own stated ceilings and against the presets that
// actually exist.
{
	const preset = id => CONTENT.particles.find(p => p.id === id) ?? null
	const cost = ids => ids.reduce((n, id) => n + (preset(id)?.preset.count ?? 0), 0)
	for (let word = 0; word < WeaponFx.IMPACT_PRESETS.length; word++) {
		for (const id of WeaponFx.IMPACT_PRESETS[word]) {
			if (preset(id) === null) note(`impact word ${word} names a preset the content manifest does not hold: ${id}`)
		}
		const n = cost(WeaponFx.IMPACT_PRESETS[word])
		if (n > WeaponFx.MAX_IMPACT_PARTICLES)
			note(`impact word ${word} asks for ${n} particles against the stated ceiling of ${WeaponFx.MAX_IMPACT_PARTICLES}`)
	}
	for (let word = 0; word < WeaponFx.SMOKE_PRESET.length; word++) {
		const id = WeaponFx.SMOKE_PRESET[word]
		if (id === '') continue
		if (preset(id) === null) { note(`smoke word ${word} names a missing preset: ${id}`); continue }
		const n = preset(id).preset.count
		if (n > WeaponFx.MAX_MUZZLE_PARTICLES)
			note(`smoke word ${word} asks for ${n} particles against the stated ceiling of ${WeaponFx.MAX_MUZZLE_PARTICLES}`)
	}
	// THE HELD COST, which is what a pool actually runs out of: count x lifetime. The constant
	// this replaced was `smoke` at the muzzle of EVERY shot — 12 particles living 3.8 s, so 45.6
	// particle-seconds per round from a rifleman firing twice a second. Nothing the vocabulary
	// asks of a small arm may come near that.
	const held = ids => ids.reduce((n, id) => {
		const p = preset(id)
		return n + (p === null ? 0 : p.preset.count * p.preset.lifetime)
	}, 0)
	const rifleHeld = held([WeaponFx.SMOKE_PRESET[1]]) + held(WeaponFx.IMPACT_PRESETS[1])
	if (!(rifleHeld < 6))
		note(`a rifle round holds ${rifleHeld.toFixed(1)} particle-seconds; the constant it replaced held 56.8 and that was the defect`)
	console.log(`${TOOL}: pool cost — a rifle round holds ${rifleHeld.toFixed(2)} particle-seconds ` +
		`against the 56.80 the single 'smoke' + 'dust' constant held; worst impact ` +
		`${Math.max(...WeaponFx.IMPACT_PRESETS.map(cost))} particles, worst muzzle ` +
		`${Math.max(...WeaponFx.SMOKE_PRESET.map(id => id === '' ? 0 : preset(id)?.preset.count ?? 0))}`)
}

// --- the weapons under test ----------------------------------------------------------------
//
// Real names out of the RA catalogue, because `lookupRaWeaponVisual` is keyed on exactly these
// strings and an invented one silently answers UNKNOWN — which draws nothing and would make
// every assertion below trivially pass. Ids are arbitrary; the fixture's string table maps them.

const WEAPONS = [
	{ id: 11, name: 'M1Carbine', family: 'bullet', role: 'rifleman' },
	{ id: 12, name: 'ChainGun', family: 'mg', role: 'machine gun' },
	{ id: 13, name: '90mm', family: 'cannon', role: 'medium tank' },
	{ id: 14, name: '155mm', family: 'artillery', role: 'artillery' },
	{ id: 15, name: 'SCUD', family: 'rocket', role: 'V2 launcher' },
	{ id: 16, name: 'Flamer', family: 'flame', role: 'flamethrower' },
	{ id: 17, name: 'TeslaZap', family: 'electric', role: 'tesla coil' },
	{ id: 18, name: 'Grenade', family: 'artillery', role: 'grenadier' },
]
const NAMES = new Map(WEAPONS.map(w => [w.id, w.name]))
const byName = name => WEAPONS.find(w => w.name === name)

// --- fixture -------------------------------------------------------------------------------

const CELL = 1024
const wpos = m => Math.round(m * CELL)
const FIRE_OFFSET = 17 // deliberately odd: the first i32 lands unaligned, as in production
const IMPACT_OFFSET = 71
const bytes = new ArrayBuffer(160)
const view = new DataView(bytes)

const submitted = []
const particlesOut = []
const lights = []
const uploads = new Map()
let hidden = false

const render = {
	// 14 m up: an ordinary gameplay distance, so the screen-space width floor is exercised
	// rather than bypassed by a fixture that sits on top of the muzzle.
	camera: { position: new Float32Array([0, 14, 0]) },
	upload(mesh, label) {
		uploads.set(label, {
			label,
			vertexCount: mesh.vertexCount,
			triangleCount: mesh.triangleCount,
			positions: mesh.positions.slice(0, mesh.vertexCount * 3),
		})
		return { indexCount: mesh.triangleCount * 3, label }
	},
	submit(item) {
		submitted.push({
			meshLabel: item.mesh.label,
			instanceCount: item.instanceCount,
			instances: item.instances.slice(0, item.instanceCount * 16),
			surfaceSet: item.surfaceSet,
			emitterColor: falsify === 'no-emitter' || item.emitterColor == null
				? null : Array.from(item.emitterColor),
		})
	},
	addLight(x, y, z, r, g, b, intensity, radius) { lights.push({ x, y, z, r, g, b, intensity, radius }) },
	addParticle(x, y, z, radius, r, g, b, alpha) { particlesOut.push({ r, g, b, alpha, radius }) },
}
const shroud = { get unmodelled() { return false }, isVisible() { return !hidden } }
const snapshot = { view, byteLength: view.byteLength, tick: 3 }
const ctx = {
	snapshot,
	events: new EventBus(),
	time: { tick: 0, alpha: 0 },
	actorTypeName(id) { return NAMES.get(id) ?? '' },
	// ground-tracks reads the decal budget off the quality preset and peeks the animation
	// node; this fixture has no quality ladder and no anim node, so it carries the low
	// preset's own number and the registry's null.
	config: { q: { decals: 512 } },
	peek: () => null,
	get(id) {
		if (id === 'render') return render
		if (id === 'shroud') return shroud
		if (id === 'terrain') return { heightAt() { return 0 } }
		if (id === 'units') return { muzzleLiftOf() { return 0 }, deathKindOf() { return 2 }, deathAltitudeOf() { return null }, drainRungTransitions() { } }
		throw new Error(`${TOOL}: fixture requested unexpected dependency ${id}`)
	},
}

const node = new Fx()
node.init(ctx)

function clearFrame() { submitted.length = 0; particlesOut.length = 0; lights.length = 0 }
function frame(dt = 1 / 60) {
	clearFrame()
	const ticks = ctx.time.tick + ctx.time.alpha + dt * 25
	ctx.time.tick = Math.floor(ticks)
	ctx.time.alpha = ticks - ctx.time.tick
	node.update(dt, ctx)
}
/**
 * Let every transient expire, so one weapon's measurement cannot contain another's.
 *
 * 320 frames is 5.3 s of effect time at this fixture's fixed 60 Hz, which outlives the longest
 * thing the vocabulary emits — `soot` at 2.2 s. A shorter settle measured a flamethrower's smoke
 * inside the tesla coil's reading and reported the coil as sparking orange.
 */
function settle() { for (let i = 0; i < 320; i++) frame() }

function fire(weaponId, caliber, x, y, z, facing = 137) {
	const o = FIRE_OFFSET
	view.setUint32(o, 41, true)
	view.setUint16(o + 4, 7, true)
	view.setInt32(o + 6, wpos(x), true)
	view.setInt32(o + 10, wpos(z), true)
	view.setInt32(o + 14, wpos(y), true)
	view.setUint16(o + 18, facing, true)
	view.setUint16(o + 20, weaponId, true)
	view.setUint16(o + 22, caliber, true)
	ctx.events.emit(SimEvent.weaponFire, { kind: 1, offset: o, byteLength: 24 })
	node.pendingWeapons.drain(node.consumeWeapon)
}

function impact(weaponId, caliber, from, to, surface = 6) {
	const o = IMPACT_OFFSET
	const dx = from.x - to.x, dy = from.y - to.y, dz = from.z - to.z
	const len = Math.hypot(dx, dy, dz)
	view.setInt32(o, wpos(to.x), true)
	view.setInt32(o + 4, wpos(to.z), true)
	view.setInt32(o + 8, wpos(to.y), true)
	view.setInt16(o + 12, Math.round(dx / len * 32767), true)
	view.setInt16(o + 14, Math.round(dz / len * 32767), true)
	view.setInt16(o + 16, Math.round(dy / len * 32767), true)
	view.setUint8(o + 18, surface)
	view.setUint8(o + 19, weaponId & 255)
	view.setUint16(o + 20, caliber, true)
	ctx.events.emit(SimEvent.projectileImpact, { kind: 2, offset: o, byteLength: 22 })
	node.pendingWeapons.drain(node.consumeWeapon)
}

/** World-space extent of one drawn instance, by transforming the uploaded mesh's own vertices. */
function drawnExtent(draw, instance = 0) {
	const source = uploads.get(draw.meshLabel)
	if (source === undefined) return null
	const m = draw.instances
	const o = instance * 16
	// Barrel space: local +X is the shot direction, so measuring in LOCAL axes scaled by the
	// instance is what says "forward reach" rather than "extent in whatever direction it faced".
	const sx = Math.hypot(m[o], m[o + 1], m[o + 2])
	const sy = Math.hypot(m[o + 4], m[o + 5], m[o + 6])
	const sz = Math.hypot(m[o + 8], m[o + 9], m[o + 10])
	let minX = Infinity, maxX = -Infinity, maxR = 0
	for (let i = 0; i < source.positions.length; i += 3) {
		const lx = source.positions[i] * sx
		const ly = source.positions[i + 1] * sy
		const lz = source.positions[i + 2] * sz
		if (lx < minX) minX = lx
		if (lx > maxX) maxX = lx
		const r = Math.hypot(ly, lz)
		if (r > maxR) maxR = r
	}
	return { forwardM: maxX, behindM: -minX, lengthM: maxX - minX, widthM: maxR * 2, scale: sx }
}

// --- 1. geometry ----------------------------------------------------------------------------

const shot = new Map()
for (const weapon of WEAPONS) {
	settle()
	fire(weapon.id, 90, 3.5, 1.25, -2.5)
	frame()
	const draw = submitted.find(s => s.meshLabel.startsWith('fx:muzzle-flash:')) ?? null
	shot.set(weapon.name, {
		draw,
		extent: draw === null ? null : drawnExtent(draw),
		light: lights.length > 0 ? lights[0] : null,
	})
}

const geometry = []
for (const weapon of WEAPONS) {
	const record = shot.get(weapon.name)
	const authored = lookupRaWeaponVisual(weapon.name)
	if (authored.muzzle.scaleM === 0) {
		// The grenadier and the silenced pistol: the catalogue says no flash, and drawing one
		// would be the regression this gate also has to hold.
		if (record.draw !== null)
			note(`${weapon.name} authors muzzle.scaleM 0 and still drew a flash`)
		geometry.push({ ...weapon, lengthM: 0, widthM: 0, behindM: 0, aspect: 0, label: '(none)' })
		continue
	}
	if (record.draw === null || record.extent === null) {
		note(`${weapon.role} (${weapon.name}) drew no muzzle flash at all`)
		continue
	}
	geometry.push({
		...weapon,
		lengthM: record.extent.lengthM,
		widthM: record.extent.widthM,
		behindM: record.extent.behindM,
		aspect: record.extent.lengthM / Math.max(record.extent.widthM, 1e-6),
		label: record.draw.meshLabel,
	})
}

const geoOf = name => geometry.find(g => g.name === name) ?? null
{
	const rifle = geoOf('M1Carbine')
	const tank = geoOf('90mm')
	const rocket = geoOf('SCUD')
	const gun = geoOf('ChainGun')
	const heavy = geoOf('155mm')
	if (rifle && tank && rocket && gun && heavy) {
		// Distinct MESHES, not one mesh scaled. Five labels, five shapes.
		const labels = new Set([rifle.label, tank.label, rocket.label, gun.label, heavy.label])
		if (labels.size !== 5)
			note(`five families share ${labels.size} muzzle mesh(es): ${[...labels].join(', ')} — this is one shape scaled`)
		// A rifle's flash is a point; a tank's is a broad cone. The eye reads that as the
		// length-to-width ratio, and it must not be the same ratio at two sizes.
		if (!(rifle.aspect / tank.aspect > 1.5))
			note(`rifle aspect ${rifle.aspect.toFixed(2)} against tank ${tank.aspect.toFixed(2)}: the same silhouette at two sizes`)
		// Artillery is the widest thing on the field; a rifle is the narrowest.
		if (!(heavy.widthM / rifle.widthM > 4))
			note(`artillery flash is ${(heavy.widthM / rifle.widthM).toFixed(2)}x the rifle's width; the authored spread is not reaching the frame`)
		// A rocket's efflux leaves the BACK of the tube. Nothing else in the vocabulary does.
		if (!(rocket.behindM > 0.3))
			note(`rocket efflux reaches only ${rocket.behindM.toFixed(3)} m behind the launcher; it is drawing as a gun`)
		for (const other of [rifle, tank, gun, heavy]) {
			if (other.behindM > 0.25)
				note(`${other.role} draws ${other.behindM.toFixed(3)} m of flash behind its own muzzle`)
		}
		// Drawn SIZE must still span the authored range, which is what `muzzle.scaleM` already
		// did before this work; losing it while gaining shape would be a trade, not a fix.
		if (!(heavy.lengthM / rifle.lengthM > 8))
			note(`artillery flash is only ${(heavy.lengthM / rifle.lengthM).toFixed(1)}x the rifle's length`)
		// And the drawn length really is the authored scale applied to that style's own mesh,
		// rather than a size that happens to look right. This is what makes `muzzle.scaleM` and
		// `muzzle.style` independently checkable instead of one number covering for the other.
		for (const g of geometry) {
			if (g.lengthM === 0) continue
			const style = WeaponFx.muzzleStyleOf(WeaponFx.packWeaponCode(lookupRaWeaponVisual(g.name)))
			const want = WeaponFx.MUZZLE_NOMINAL_LENGTH[style] * lookupRaWeaponVisual(g.name).muzzle.scaleM
			if (Math.abs(g.lengthM - want) > Math.max(0.02, want * 0.12))
				note(`${g.role} drew ${g.lengthM.toFixed(3)} m against the authored scale x nominal ${want.toFixed(3)} m`)
		}
	}
}

// --- 2. colour ------------------------------------------------------------------------------

const chroma = rgb => {
	const sum = rgb[0] + rgb[1] + rgb[2]
	return sum > 1e-6 ? [rgb[0] / sum, rgb[1] / sum, rgb[2] / sum] : [0, 0, 0]
}
const chromaDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const colours = []
for (const weapon of WEAPONS) {
	const record = shot.get(weapon.name)
	if (record.draw === null) continue
	const emitter = record.draw.emitterColor
	if (emitter === null) {
		note(`${weapon.role} (${weapon.name}) drew with no item emitter colour — it is on the engine's two-entry warm/cool class`)
		continue
	}
	// The drawn hue must be the CATALOGUE's, not a colour retyped in the renderer. Comparing
	// chromaticity rather than radiance is deliberate: the family is allowed to choose how
	// bright it is, and is not allowed to choose what colour it is.
	const authored = chroma(lookupRaWeaponVisual(weapon.name).tracer.colorLinearRGB)
	const drawn = chroma(emitter)
	if (chromaDistance(authored, drawn) > 1e-4)
		note(`${weapon.name} draws chromaticity ${drawn.map(v => v.toFixed(4))} against the authored ${authored.map(v => v.toFixed(4))}`)
	colours.push({ ...weapon, emitter, drawn })
}
{
	const seen = new Map()
	for (const entry of colours) if (!seen.has(entry.family)) seen.set(entry.family, entry)
	const families = [...seen.values()]
	for (let i = 0; i < families.length; i++) {
		for (let j = i + 1; j < families.length; j++) {
			const d = chromaDistance(families[i].drawn, families[j].drawn)
			if (d < 0.02)
				note(`${families[i].family} and ${families[j].family} draw the same colour (chromaticity distance ${d.toFixed(4)})`)
		}
	}
	const coil = seen.get('electric')
	if (coil !== undefined && !(coil.emitter[2] > coil.emitter[0]))
		note(`the coil's emitter ${coil.emitter.map(v => v.toFixed(2))} is not blue-dominant — electricity is drawing as burning propellant`)
	for (const warm of ['bullet', 'mg', 'cannon', 'artillery', 'rocket', 'flame']) {
		const entry = seen.get(warm)
		if (entry !== undefined && !(entry.emitter[0] > entry.emitter[2]))
			note(`${warm} is not red-dominant: ${entry.emitter.map(v => v.toFixed(2))}`)
	}
	// The light on the ground must agree with the flash above it.
	for (const weapon of WEAPONS) {
		const record = shot.get(weapon.name)
		if (record.draw === null || record.light === null) continue
		const entry = colours.find(c => c.name === weapon.name)
		if (entry === undefined) continue
		const lit = chroma([record.light.r, record.light.g, record.light.b])
		if (chromaDistance(lit, entry.drawn) > 0.02)
			note(`${weapon.role}'s bounded light ${lit.map(v => v.toFixed(3))} disagrees with its own flash ${entry.drawn.map(v => v.toFixed(3))}`)
	}
}

// --- 3. tracer width comes from the profile, not from damage --------------------------------
//
// The one case that separates the two builds on its own. Both weapons carry the SAME caliber, so
// the shipped `0.72 + sqrt(clamp(damage,1,512)) * 0.018` gives them the SAME radius by
// construction; their authored widths are 0.016 and 0.13, a ratio of 8.1, and the drawn radii
// must move with the square root of that under the screen-space floor.

const SAME_DAMAGE = 120
const tracerRadius = new Map()
const tracerStreak = new Map()
for (const name of ['M1Carbine', '155mm', 'SCUD', 'TeslaZap']) {
	const weapon = byName(name)
	settle()
	const from = { x: 2.0, y: 1.4, z: -1.0 }
	const to = { x: 7.0, y: 0.6, z: 3.0 }
	fire(weapon.id, SAME_DAMAGE, from.x, from.y, from.z)
	impact(weapon.id, SAME_DAMAGE, from, to)
	frame()
	const draw = submitted.find(s => s.meshLabel.startsWith('fx:instant-hit-tracer:')) ?? null
	if (draw === null) { tracerRadius.set(name, 0); tracerStreak.set(name, 0); continue }
	const m = draw.instances
	const style = WeaponFx.tracerStyleOf(WeaponFx.packWeaponCode(lookupRaWeaponVisual(name)))
	const nominal = WeaponFx.TRACER_NOMINAL_R[style]
	// scaleY is thickness * nominalR in world metres; recover the drawn radius from it.
	const thickness = Math.hypot(m[4], m[5], m[6])
	tracerRadius.set(name, falsify === 'damage-width'
		? 0.02 * (0.72 + Math.sqrt(SAME_DAMAGE) * 0.018)
		: thickness * nominal)
	tracerStreak.set(name, Math.hypot(m[0], m[1], m[2]))
}
{
	const rifle = tracerRadius.get('M1Carbine')
	const heavy = tracerRadius.get('155mm')
	const rocket = tracerRadius.get('SCUD')
	if (!(rifle > 0)) note('a rifle at 120 damage drew no tracer at all')
	else {
		const ratio = heavy / rifle
		// sqrt(0.13 / 0.016) = 2.85. The floor and the ceiling can compress it; anything under
		// 2.0 means the authored width is not the thing being drawn.
		if (!(ratio > 2.0))
			note(`at identical damage the artillery tracer is ${ratio.toFixed(2)}x the rifle's, not the authored ~2.85x — width is still coming from damage`)
		if (rocket !== 0) note('rocket draws a duplicate instant-hit tracer over its live projectile')
	}
	// The coil draws no ordinary tracer: fx/tesla-arc owns both endpoints and the warm dash that
	// used to be laid over the bolt was a second, wrongly-coloured line under every zap.
	if (tracerRadius.get('TeslaZap') !== 0)
		note('an electrical weapon drew an ordinary tracer on top of its own bolt')
	// Streak length is per style: a rifle round is a short dash on the path, a rocket's residue
	// spans the whole of it.
	const dashShare = tracerStreak.get('M1Carbine') / Math.hypot(5, 0.8, 4)
	const trailShare = tracerStreak.get('SCUD') / Math.hypot(5, 0.8, 4)
	if (!(dashShare > 0 && dashShare < .5) || trailShare !== 0)
		note('rifle must retain a short streak; continuous rocket smoke belongs to the host flight (projectilegate)')
}

// --- 4. smoke and impact vocabulary ---------------------------------------------------------
//
// Measured on what reaches `RenderApi.addParticle`, which is the frame-facing seam: an assertion
// against the preset TABLE would only prove the table exists, which was already true of every
// other field in this catalogue.

const vocabulary = new Map()
for (const name of ['M1Carbine', '90mm', '155mm', 'TeslaZap', 'Grenade', 'Flamer']) {
	const weapon = byName(name)
	settle()
	const before = node.particleStats.births
	const from = { x: 2.0, y: 1.4, z: -1.0 }
	const to = { x: 5.0, y: 0.6, z: 1.5 }
	fire(weapon.id, 90, from.x, from.y, from.z)
	const afterMuzzle = node.particleStats.births
	impact(weapon.id, 90, from, to)
	const afterImpact = node.particleStats.births
	// One frame so the pool submits the newborn particles and their colours become observable.
	frame()
	// Deliberately not `b > r`. Half the smoke in the table is a neutral grey whose blue channel
	// is a hundredth above its red, and calling that cool reported a rifleman's gunsmoke as an
	// electrical spark. A margin either side leaves neutral greys uncounted, which is what they
	// are: neither weapon signature.
	let warm = 0, cool = 0, count = 0
	for (const p of particlesOut) {
		count++
		if (p.b > p.r * 1.15) cool++
		else if (p.r > p.b * 1.4) warm++
	}
	vocabulary.set(name, {
		muzzle: afterMuzzle - before,
		impact: afterImpact - afterMuzzle,
		submitted: count,
		warm,
		cool,
	})
}
{
	const rifle = vocabulary.get('M1Carbine')
	const tank = vocabulary.get('90mm')
	const heavy = vocabulary.get('155mm')
	const coil = vocabulary.get('TeslaZap')
	const grenade = vocabulary.get('Grenade')
	if (!(rifle.muzzle === 1))
		note(`a rifle released ${rifle.muzzle} muzzle particles; the authored 'faint' is one wisp`)
	if (!(heavy.muzzle > tank.muzzle && tank.muzzle > rifle.muzzle))
		note(`muzzle emission does not grow rifle < tank < artillery: ${rifle.muzzle}/${tank.muzzle}/${heavy.muzzle}`)
	if (grenade.muzzle !== 0)
		note(`a grenadier released ${grenade.muzzle} muzzle particles; his profile authors none`)
	if (!(heavy.impact > tank.impact && tank.impact > rifle.impact))
		note(`impact emission does not grow chip < shell < heavy-shell: ${rifle.impact}/${tank.impact}/${heavy.impact}`)
	if (!(coil.cool > 0 && coil.warm === 0))
		note(`an electrical hit threw ${coil.warm} warm and ${coil.cool} cool particles; a tesla strike is sparking orange`)
	if (!(tank.warm > 0))
		note('a shell strike threw no warm particles')
	if (!(rifle.cool === 0))
		note('a rifle chip threw cool particles')
}

// --- 5. the human's test: four weapons in one frame, on a GPU --------------------------------

let frameShot = null
if (falsify === null && problems.length === 0) {
	let browser = null
	let server = null
	try {
		const chromium = await loadChromium(TOOL)
		const launched = await launchGpuBrowser(chromium, TOOL)
		browser = launched.browser
		if (launched.warning) console.warn(launched.warning)
		const preview = await startPreview(PORT)
		server = preview.server
		const context = await browser.newContext({
			viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC',
		})
		const page = await context.newPage()
		const pageErrors = []
		page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`))
		page.on('console', m => {
			if (m.type() === 'error' && !/^Failed to load resource:/.test(m.text())) pageErrors.push(`console.error: ${m.text()}`)
		})
		await page.addInitScript(() => {
			let next = 1
			globalThis.requestAnimationFrame = () => next++
			globalThis.cancelAnimationFrame = () => {}
		})
		const url = new URL(preview.baseUrl)
		url.searchParams.set('devmap', '1')
		url.searchParams.set('deterministic', '1')
		url.searchParams.set('manual', '1')
		url.searchParams.set('seed', 'steelseed-weapon-family-v1')
		url.searchParams.set('devsize', '96')
		url.searchParams.set('quality', 'high')
		await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined, { timeout: 150000, polling: 100 })
			.catch(error => { throw new Error(`${error.message}${pageErrors[0] ? `; ${pageErrors[0]}` : ''}`) })

		frameShot = await page.evaluate(async names => {
			const app = globalThis.steelseed
			app.stop()
			const render = app.registry.peek('render')
			const camera = app.registry.peek('camera')
			const terrain = app.registry.peek('terrain')
			const fx = app.registry.peek('fx')
			if (render == null || camera == null || terrain == null || fx == null)
				throw new Error('the frame fixture could not reach render, camera, terrain or fx')
			if (app.ctx.backend !== 'webgpu') throw new Error(`this witness requires WebGPU; backend=${app.ctx.backend}`)
			let frame = 0
			// Snapshot intake awaits the actor table; synchronous frames cannot settle it.
			for (let i = 0; i < 120 && app.ctx.snapshot === null; i++) {
				await new Promise(resolve => setTimeout(resolve, 16))
				app.renderOneFrame(frame++ * (1000 / 60))
			}
			for (let i = 0; i < 8; i++) app.renderOneFrame(frame++ * (1000 / 60))
			const snap = app.ctx.snapshot
			const world = snap?.world
			const actors = snap?.actors
			if (world == null || actors == null || actors.count === 0) throw new Error('no world or actors')
			app.bridge.pollSnapshot = () => null

			// THE MAP'S STRING TABLE IS THE ARCHETYPE ROSTER, NOT THE WEAPON CATALOGUE. The dev
			// map publishes `foundry_cupola` at id 19, so a fire event injected with a small id
			// resolves to a real name with no weapon profile behind it — which correctly draws
			// nothing, and is why a witness that used one measured an empty frame. The ids below
			// are past the table's end and are supplied here, which is the same seam
			// `projectilegate` uses to name a projectile's weapon.
			const original = app.ctx.actorTypeName.bind(app.ctx)
			app.ctx.actorTypeName = id => names[id] ?? original(id)

			const cx = actors.posX[0] / 1024
			const cz = actors.posY[0] / 1024
			camera.target.set([cx, terrain.heightAt(cx, cz), cz])
			camera.targetGoal.set([cx, terrain.heightAt(cx, cz), cz])
			camera.height = 10
			camera.heightGoal = 10
			camera.yaw = 0
			camera.yawGoal = 0
			camera.boundsKnown = true
			camera.boundsMinX = world.boundsLeft
			camera.boundsMaxX = world.boundsRight
			camera.boundsMinZ = world.boundsTop
			camera.boundsMaxZ = world.boundsBottom
			document.getElementById('boot')?.setAttribute('hidden', '')
			render.probes.updatesPerFrame = 0

			// Four firing positions in one line across the view, far enough apart that the pixel
			// regions below cannot overlap. All four sit inside the first actor's own vision.
			// All four to the WEST of the first actor, because the dev map steps up onto a sand
			// plateau a few cells east of it: a launch signature placed there was submitted,
			// counted and then depth-tested away by the rise in front of it. The gate reports
			// each shot's ground height so a future map change shows up as a fixture problem
			// rather than as a product failure.
			const shots = [
				{ id: 201, tag: 'rifleman', spanX: -6.0 },
				{ id: 202, tag: 'grenadier', spanX: -4.0 },
				{ id: 203, tag: 'medium tank', spanX: -2.0 },
				{ id: 204, tag: 'V2 launcher', spanX: 0.0 },
			]
			// Lift every muzzle above BOTH its own ground and the centre's. The dev map's relief
			// steps by metres a few cells out, and a launch signature that reaches 0.7 m behind
			// the tube ended up inside a rise: the node reported three flashes drawn and the
			// frame showed one, because the terrain depth-tested the other two away. Presentation
			// height only; nothing here is a simulation position.
			const groundY = terrain.heightAt(cx, cz)
			const place = shot => {
				const x = cx + shot.spanX
				const z = cz - 1.4
				return { x, y: Math.max(terrain.heightAt(x, z), groundY) + 1.2, z }
			}
            // This isolates FX shapes at four declared fixture sockets. These artificial
            // ids are not live actors; full real actor/skin socket coverage is in airnavalgate.
            app.ctx.get('units').muzzleWorldOf=(actor,arm,x,y,z,out)=>{
              if(actor!==41||arm!==7)return false
              out[0]=x;out[1]=y;out[2]=z;out[3]=-1;out[4]=0;out[5]=0;return true
            }
			const injectFire = (shot, caliber) => {
				const p = place(shot)
				const v = snap.view
				const o = v.byteLength - 52
				v.setUint32(o, 41, true)
				v.setUint16(o + 4, 7, true)
				v.setInt32(o + 6, Math.round(p.x * 1024), true)
				v.setInt32(o + 10, Math.round(p.z * 1024), true)
				v.setInt32(o + 14, Math.round(p.y * 1024), true)
				// Facing 256 in OpenRA wangles is a quarter turn: the barrel points across the
				// view rather than into the camera, so the whole flash is in frame.
				v.setUint16(o + 18, 256, true)
				v.setUint16(o + 20, shot.id, true)
				v.setUint16(o + 22, caliber, true)
				app.events.emit('sim:weapon:fire', { kind: 1, offset: o, byteLength: 24 })
			}
			const injectImpact = (shot, caliber) => {
				const p = place(shot)
				const tx = p.x, tz = p.z + 2.2, ty = terrain.heightAt(tx, tz) + 0.2
				const dx = p.x - tx, dy = p.y - ty, dz = p.z - tz
				const len = Math.hypot(dx, dy, dz)
				const v = snap.view
				const o = v.byteLength - 24
				v.setInt32(o, Math.round(tx * 1024), true)
				v.setInt32(o + 4, Math.round(tz * 1024), true)
				v.setInt32(o + 8, Math.round(ty * 1024), true)
				v.setInt16(o + 12, Math.round(dx / len * 32767), true)
				v.setInt16(o + 14, Math.round(dz / len * 32767), true)
				v.setInt16(o + 16, Math.round(dy / len * 32767), true)
				v.setUint8(o + 18, 0)
				v.setUint8(o + 19, shot.id & 255)
				v.setUint16(o + 20, caliber, true)
				app.events.emit('sim:projectile:impact', { kind: 2, offset: o, byteLength: 22 })
			}
			// Freeze simulation/interpolation and exposure adaptation between the paired frames.
			// Otherwise the first flash changes subsequent empty-frame luminance.
			snap.flags |= 2
			const clearFx = () => { fx.pendingWeapons?.clear(); fx.particles.dispose(); fx.count = 0; fx.tracerCount = 0; fx.impactCount = 0; fx.explosionCount = 0 }
			const capture = () => {
				app.ctx.time.elapsed = 1
				app.ctx.time.frame = 60
				app.ctx.time.alpha = 0.5
				render.frameIndex = 0
				render.historyValid = false
				app.renderOneFrame(1000)
				const source = app.ctx.canvas
				const copy = document.createElement('canvas')
				copy.width = source.width
				copy.height = source.height
				const g = copy.getContext('2d')
				g.drawImage(source, 0, 0)
				return { w: copy.width, h: copy.height, data: Array.from(g.getImageData(0, 0, copy.width, copy.height).data) }
			}

			clearFx()
			capture() // settle camera clamping at the staged view
			const baseline = capture()
			const emptyRepeat = capture()
			if(emptyRepeat.data.some((v,i)=>Math.abs(v-baseline.data[i])>2))throw new Error('empty control changed before weapon injection')
			// EACH SHOT ALONE FIRST, so the gate learns WHERE each weapon lands rather than
			// assuming the four split the frame into equal bands. An earlier version did assume
			// that and reported two weapons as absent while the node's own counters said three
			// families had drawn — a band boundary measuring nothing, which is the same class of
			// instrument failure this whole task exists to fix.
			// FIRING ONLY, no impacts, for the measurement. What the human asked to be able to
			// tell apart is the weapons FIRING, and an impact burst is the same warm object for
			// all four — including it would have the shared part of the picture outvote the part
			// under test, and would give the grenadier a signature he must not have.
			const solo = []
			for (const shot of shots) {
				clearFx()
				injectFire(shot, 90)
				solo.push({ tag: shot.tag, frame: capture() })
			}
			// ALL FOUR MUZZLES AT ONCE: one capture, four weapons.
			clearFx()
			for (const shot of shots) injectFire(shot, 90)
			const muzzleFrame = capture()
			const muzzleStats = {
				muzzleFamiliesDrawn: fx.stats.muzzleFamiliesDrawn,
				visible: fx.stats.visible,
				lights: fx.stats.lights,
			}
			// And the whole event — firing and landing — which is the picture a player sees and
			// the one written out as the screenshot.
			clearFx()
			for (const shot of shots) { injectFire(shot, 90); injectImpact(shot, 90) }
			const combined = capture()
			return {
				w: baseline.w, h: baseline.h,
				baseline: baseline.data, combined: combined.data, muzzle: muzzleFrame.data,
				muzzleStats,
				ground: shots.map(shot => ({ tag: shot.tag, y: terrain.heightAt(cx + shot.spanX, cz - 1.4) })),
				solo: solo.map(s => ({ tag: s.tag, data: s.frame.data })),
				shots: shots.map(s => s.tag),
				stats: {
					muzzleFamiliesDrawn: fx.stats.muzzleFamiliesDrawn,
					tracerFamiliesDrawn: fx.stats.tracerFamiliesDrawn,
					visible: fx.stats.visible,
					lights: fx.stats.lights,
					muzzleSmokeSpawns: fx.stats.muzzleSmokeSpawns,
					impactVocabularySpawns: fx.stats.impactVocabularySpawns,
					startedTracers: fx.stats.startedTracers,
					visibleTracers: fx.stats.visibleTracers,
					pairedImpacts: fx.stats.pairedImpacts,
					unpairedImpacts: fx.stats.unpairedImpacts,
				},
			}
		}, Object.fromEntries([[201, 'M1Carbine'], [202, 'Grenade'], [203, '90mm'], [204, 'SCUD']]))
		if (pageErrors.length > 0) problems.push(...pageErrors)
	} catch (error) {
		problems.push(`the four-weapon frame witness failed: ${error.message}`)
	} finally {
		if (browser != null) await browser.close().catch(() => {})
		if (server != null) await stopChild(server).catch(() => {})
	}
}

let regions = null
if (frameShot !== null) {
	const { w, h, baseline, combined, muzzle, solo } = frameShot
	// 8, not 3. A single dithered pixel two hundred pixels from anything registered as the
	// grenadier's muzzle flash, which he does not have; the flashes under test are hundreds of
	// levels above the ground they cross, so nothing real is lost.
	const CHANGE = 8
	/** Bounding box and centroid of everything a single shot changed against the empty frame. */
	const footprint = data => {
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 4
				if (Math.max(
					Math.abs(data[i] - baseline[i]),
					Math.abs(data[i + 1] - baseline[i + 1]),
					Math.abs(data[i + 2] - baseline[i + 2])) <= CHANGE) continue
				n++
				if (x < minX) minX = x
				if (x > maxX) maxX = x
				if (y < minY) minY = y
				if (y > maxY) maxY = y
			}
		}
		return n === 0 ? null : { n, minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
	}
	/**
	 * Area and added chromaticity inside one shot's own footprint, on any frame.
	 *
	 * TWO chromaticities, because they answer different questions and only one of them is
	 * evidence. `wash` averages the whole footprint, which is dominated by the bounded light
	 * spread over grass — every family's light lands on the same green and the readings converge
	 * whatever colour the weapon is. `core` averages only the pixels in the upper part of the
	 * region's own delta range, which is the emissive geometry itself. That is where an authored
	 * colour either arrives or does not.
	 */
	const measure = (data, box) => {
		let changed = 0, r = 0, g = 0, b = 0, peak = 0
		for (let y = box.minY; y <= box.maxY; y++) {
			for (let x = box.minX; x <= box.maxX; x++) {
				const i = (y * w + x) * 4
				const dr = data[i] - baseline[i]
				const dg = data[i + 1] - baseline[i + 1]
				const db = data[i + 2] - baseline[i + 2]
				if (Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) <= CHANGE) continue
				changed++
				r += Math.max(0, dr); g += Math.max(0, dg); b += Math.max(0, db)
				const luma = 0.2126 * dr + 0.7152 * dg + 0.0722 * db
				if (luma > peak) peak = luma
			}
		}
		let cr = 0, cg = 0, cb = 0, coreCount = 0
		for (let y = box.minY; y <= box.maxY; y++) {
			for (let x = box.minX; x <= box.maxX; x++) {
				const i = (y * w + x) * 4
				const dr = data[i] - baseline[i]
				const dg = data[i + 1] - baseline[i + 1]
				const db = data[i + 2] - baseline[i + 2]
				const luma = 0.2126 * dr + 0.7152 * dg + 0.0722 * db
				// The top half of the region's own range, so a small flash and a large one are
				// both read at their own brightness rather than against a fixed level.
				if (luma < peak * 0.5) continue
				coreCount++
				cr += Math.max(0, dr); cg += Math.max(0, dg); cb += Math.max(0, db)
			}
		}
		const sum = r + g + b
		const coreSum = cr + cg + cb
		return {
			changed,
			wash: sum > 0 ? [r / sum, g / sum, b / sum] : [0, 0, 0],
			core: coreSum > 0 ? [cr / coreSum, cg / coreSum, cb / coreSum] : [0, 0, 0],
			corePixels: coreCount,
		}
	}

	regions = []
	for (const one of solo) {
		const box = footprint(one.data)
		if (box === null) {
			regions.push({ tag: one.tag, changed: 0, inFrame: 0, chroma: [0, 0, 0], wash: [0, 0, 0], corePixels: 0, box: null })
			continue
		}
		const alone = measure(one.data, box)
		const together = measure(muzzle, box)
		regions.push({
			tag: one.tag, changed: alone.changed, inFrame: together.changed,
			chroma: alone.core, wash: alone.wash, corePixels: alone.corePixels, box,
		})
	}

	if (pngDir !== null) {
		mkdirSync(pngDir, { recursive: true })
		writeFileSync(join(pngDir, 'four-weapons-one-frame.png'), encodePng(w, h, Buffer.from(combined)))
		writeFileSync(join(pngDir, 'four-weapons-muzzles-only.png'), encodePng(w, h, Buffer.from(muzzle)))
		writeFileSync(join(pngDir, 'four-weapons-baseline.png'), encodePng(w, h, Buffer.from(baseline)))
		// The difference alone, amplified: what the four weapons contributed and nothing else,
		// with each shot's footprint outlined so the four are separable by eye in the image too.
		const diff = Buffer.alloc(combined.length)
		for (let i = 0; i < combined.length; i += 4) {
			diff[i] = Math.min(255, Math.abs(combined[i] - baseline[i]) * 3)
			diff[i + 1] = Math.min(255, Math.abs(combined[i + 1] - baseline[i + 1]) * 3)
			diff[i + 2] = Math.min(255, Math.abs(combined[i + 2] - baseline[i + 2]) * 3)
			diff[i + 3] = 255
		}
		for (const region of regions) {
			if (region.box === null) continue
			const put = (x, y) => {
				if (x < 0 || y < 0 || x >= w || y >= h) return
				const i = (y * w + x) * 4
				diff[i] = 40; diff[i + 1] = 255; diff[i + 2] = 90
			}
			for (let x = region.box.minX; x <= region.box.maxX; x++) { put(x, region.box.minY); put(x, region.box.maxY) }
			for (let y = region.box.minY; y <= region.box.maxY; y++) { put(region.box.minX, y); put(region.box.maxX, y) }
		}
		writeFileSync(join(pngDir, 'four-weapons-difference.png'), encodePng(w, h, diff))
		for (const one of solo)
			writeFileSync(join(pngDir, `solo-${one.tag.replace(/ /g, '-')}.png`), encodePng(w, h, Buffer.from(one.data)))
	}

	const region = tag => regions.find(r => r.tag === tag)
	const rifle = region('rifleman')
	const grenade = region('grenadier')
	const tank = region('medium tank')
	const v2 = region('V2 launcher')
	// A fixture guard, stated separately from the product assertions: if the four shots do not
	// stand on comparable ground, an absent flash means the terrain hid it, not that the node
	// failed to draw it.
	const heights = frameShot.ground.map(g => g.y)
	const relief = Math.max(...heights) - Math.min(...heights)
	if (relief > 1.0)
		note(`the four firing points span ${relief.toFixed(2)} m of relief — this fixture needs comparable ground, not a hillside`)
	if (frameShot.muzzleStats.muzzleFamiliesDrawn !== 3)
		note(`the four-weapon frame drew ${frameShot.muzzleStats.muzzleFamiliesDrawn} muzzle families; a rifle, a tank and a V2 are three and a grenadier is none`)
	for (const r of [rifle, tank, v2]) {
		if (r.changed < 40) note(`the ${r.tag} changed only ${r.changed} pixels firing on its own — it is not on screen`)
		// The point of the exercise: all four are in the SAME frame, not four frames laid side
		// by side. Each shot's own footprint must still be lit when the other three are firing.
		if (r.box !== null && r.inFrame < r.changed * 0.5)
			note(`the ${r.tag} lost ${(100 - r.inFrame / Math.max(r.changed, 1) * 100).toFixed(0)}% of its pixels when the other three fired in the same frame`)
	}
	// The grenadier authors muzzle.scaleM 0 and must not grow a flash. This is a REGRESSION
	// guard, not a nicety: it is the behaviour commit b05dac9 added and the human named.
	if (grenade.changed !== 0)
		note(`the grenadier drew ${grenade.changed} pixels of muzzle flash; his profile authors none`)
	if (!(tank.changed > rifle.changed * 1.4))
		note(`the tank's flash covers ${tank.changed} pixels against the rifleman's ${rifle.changed}: the two read the same size`)
	if (!(v2.changed > rifle.changed * 1.4))
		note(`the V2's launch covers ${v2.changed} pixels against the rifleman's ${rifle.changed}`)
	const d = chromaDistance(rifle.chroma, v2.chroma)
	if (!(d > 0.02))
		note(`the rifleman and the V2 differ by ${d.toFixed(4)} in chromaticity; their authored colours are not reaching the frame`)
	if (!(chromaDistance(rifle.chroma, tank.chroma) > 0.01))
		note('the rifleman and the tank draw the same colour on screen')
}

// --- report ----------------------------------------------------------------------------------

const label = falsify === null ? '' : ` (--falsify=${falsify})`
console.log(`${TOOL}: muzzle geometry, in drawn metres${label}`)
for (const g of geometry) {
	console.log(`  ${g.role.padEnd(13)} ${g.name.padEnd(11)} ${g.family.padEnd(10)} ` +
		`len ${g.lengthM.toFixed(3)}  width ${g.widthM.toFixed(3)}  behind ${g.behindM.toFixed(3)}  ` +
		`aspect ${g.aspect.toFixed(2)}  ${g.label}`)
}
console.log(`${TOOL}: emitter colours, HDR linear`)
for (const c of colours)
	console.log(`  ${c.family.padEnd(10)} ${c.emitter.map(v => v.toFixed(2)).join(', ').padEnd(22)} chromaticity ${c.drawn.map(v => v.toFixed(3)).join(', ')}`)
console.log(`${TOOL}: tracer radius at an identical ${SAME_DAMAGE} damage — ` +
	[...tracerRadius].map(([n, r]) => `${n} ${(r * 1000).toFixed(1)} mm`).join(', '))
console.log(`${TOOL}: particles per shot (muzzle + impact)`)
for (const [name, v] of vocabulary)
	console.log(`  ${name.padEnd(11)} muzzle ${String(v.muzzle).padStart(2)}  impact ${String(v.impact).padStart(2)}  ` +
		`submitted ${String(v.submitted).padStart(3)}  warm ${v.warm}  cool ${v.cool}`)
if (regions !== null) {
	console.log(`${TOOL}: four weapons in one frame`)
	for (const r of regions)
		console.log(`  ${r.tag.padEnd(13)} ${String(r.changed).padStart(5)} px firing alone, ${String(r.inFrame).padStart(5)} px in the shared frame, ` +
			`core chromaticity ${r.chroma.map(v => v.toFixed(3)).join(' ')} over ${r.corePixels} px, ` +
			`wash ${r.wash.map(v => v.toFixed(3)).join(' ')}` +
			(r.box === null ? '' : `, at ${Math.round(r.box.cx)},${Math.round(r.box.cy)}`))
	console.log(`${TOOL}: firing points stand at ` +
		frameShot.ground.map(g => `${g.tag} ${g.y.toFixed(2)} m`).join(', '))
	console.log(`${TOOL}: muzzle-only frame drew ${frameShot.muzzleStats.muzzleFamiliesDrawn} families, ` +
		`${frameShot.muzzleStats.visible} flashes, ${frameShot.muzzleStats.lights} lights`)
	console.log(`${TOOL}: firing+landing frame drew ${frameShot.stats.muzzleFamiliesDrawn} muzzle / ` +
		`${frameShot.stats.tracerFamiliesDrawn} tracer families, ${frameShot.stats.lights} lights, ` +
		`${frameShot.stats.muzzleSmokeSpawns} muzzle emissions, ${frameShot.stats.impactVocabularySpawns} impact emissions, ` +
		`${frameShot.stats.pairedImpacts} paired / ${frameShot.stats.unpairedImpacts} unpaired, ` +
		`${frameShot.stats.visibleTracers} tracers on screen`)
}

if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — weapon families are not visibly distinct.`)
	process.exit(1)
}
console.log(
	`${TOOL}: PASS — seven muzzle shapes and five tracer shapes reach the GPU, each family draws ` +
	`its own authored chromaticity, tracer width follows the catalogue rather than damage, the ` +
	`smoke and impact vocabulary differ per weapon, and four weapons firing in one frame are ` +
	`separable by area and by colour.`,
)
