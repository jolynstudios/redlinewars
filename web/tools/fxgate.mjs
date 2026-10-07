#!/usr/bin/env node
// STEELSEED — tools/fxgate
//
// Drives the production muzzle-flash, instant-hit tracer and incidence-burst node against the
// exact unaligned §4.9 payloads. A still
// cannot prove this wiring: a symmetric flash at a cardinal facing looks correct under either
// yaw sign, a retained SnapshotEvent aliases the next event, and an effect behind shroud leaks
// enemy position even while the unit mesh is correctly absent.
//
// The fixture therefore uses two distinct XYZ positions, non-cardinal facings, two calibers,
// one reused payload buffer and a hidden cell. It inspects what reaches the production RenderApi
// seam: one DrawItem, absolute transforms and lights. `capture.mjs` remains the presented-pixel
// witness; this gate names the data error when capture can only say that a frame changed.
//
// Destruction uses the existing authoritative kind-5 event. The gate keeps it separate from
// the impact burst: an impact can strike without killing, and a death can follow accumulated
// damage without a same-frame impact.
//
// Usage:
//   node tools/fxgate.mjs [--falsify=zero|emissive-zero|pair-zero|incidence-flat]


import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

const TOOL = 'fxgate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = n => {
	const hit = process.argv.find(a => a.startsWith(`--${n}=`))
	return hit ? hit.slice(n.length + 3) : null
}
const falsify = arg('falsify')
if (
	falsify !== null &&
	falsify !== 'zero' &&
	falsify !== 'emissive-zero' &&
	falsify !== 'pair-zero' &&
	falsify !== 'incidence-flat'
) {
	console.error(`${TOOL}: unknown --falsify=${falsify}`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'fxgate-'))
const entry = join(tmp, 'e.ts')
writeFileSync(entry, [
	`export { Fx } from '${WEB}/src/fx/index'`,
	`export { EventBus, SimEvent } from '${WEB}/src/core/events'`,
	`export { m4, mat4, vec3 } from '${WEB}/src/core/math'`,
	`export { Zone, ZoneFlag, hasZoneFlag, materialLayerOf, withZoneFlag } from '${WEB}/src/geo/zone'`,
	// The per-family tables, so this gate compares against what the node actually consumes
	// rather than against numbers retyped here. A gate that hardcodes a constant the node also
	// hardcodes proves the two literals match, not that the behaviour is right.
	`export { FALLBACK_CODE, FxFamily, MUZZLE_LIFETIME_S, TRACER_STREAK_FRACTION, TRACER_STREAK_MAX_M, muzzleStyleOf, tracerStyleOf } from '${WEB}/src/fx/weapon-fx'`,
].join('\n') + '\n')
const bundle = join(tmp, 'b.mjs')
// `import.meta.glob` is Vite's and this runs under plain node. `fx` reaches the forged roster
// through it for stack smoke and for building-death clouds, so without this shim the bundle
// throws `(intermediate value).glob is not a function` on import and the gate cannot start at
// all. An empty glob is the honest fixture answer: this harness has no forged pack behind it,
// and both consumers already degrade to "no authored data" rather than failing.
await esbuild({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent',
	define: { 'import.meta.glob': '__fxGateGlob' }, banner: { js: 'const __fxGateGlob = () => ({});' } })
const {
	Fx, EventBus, SimEvent, m4, mat4, vec3, Zone, ZoneFlag, hasZoneFlag, materialLayerOf, withZoneFlag,
	FALLBACK_CODE, MUZZLE_LIFETIME_S, TRACER_STREAK_FRACTION, TRACER_STREAK_MAX_M, muzzleStyleOf, tracerStyleOf,
} = await import(bundle)
// What an unnamed weapon draws. This fixture has no mod behind it, so every effect below takes
// the fallback path and the gate must expect the fallback's shape, life and streak — not a
// number copied out of the node.
const FALLBACK_MUZZLE_STYLE = muzzleStyleOf(FALLBACK_CODE)
const FALLBACK_TRACER_STYLE = tracerStyleOf(FALLBACK_CODE)
const FALLBACK_FLASH_LIFETIME_S = MUZZLE_LIFETIME_S[FALLBACK_MUZZLE_STYLE]
const FLASH_LABEL = `fx:muzzle-flash:${FALLBACK_MUZZLE_STYLE}`
const TRACER_LABEL = `fx:instant-hit-tracer:${FALLBACK_TRACER_STYLE}`

const problems = []
const note = m => problems.push(m)
const close = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps
const CELL = 1024
const wpos = m => Math.round(m * CELL)

// Neither event is symmetric in payload or direction. Event A also sits over a sloped
// synthetic ground so the report exposes any future temptation to clamp its absolute Z.
const A = { actor: 41, armament: 7, x: 3.25, y: 2.75, z: -4.5, facing: 137, weaponClass: 19, caliber: 36 }
const B = { actor: 77, armament: 3, x: -5.125, y: 4.25, z: 1.375, facing: 733, weaponClass: 51, caliber: 400 }
const HIDDEN = { actor: 93, armament: 11, x: -8.25, y: 1.5, z: 6.75, facing: 289, weaponClass: 23, caliber: 120 }
const DESTROYED = { actor: 0x10203, x: 2.375, y: 1.625, z: -3.75, kind: 0, violence: 211 }
// Same weapon identity, deliberately interleaved. FIFO pairs these incorrectly; incidence
// geometry must pair Q first and P second even though the fire order was P then Q.
const P = { actor: 101, armament: 5, x: -2.75, y: 3.125, z: -1.5, facing: 163, weaponClass: 61, caliber: 180 }
const Q = { actor: 102, armament: 5, x: 4.625, y: 2.25, z: 3.875, facing: 811, weaponClass: 61, caliber: 180 }
const PI = impactFor(P, { x: 3.5, y: 0.875, z: -5.25 }, 6) // metal -> warm
const QI = impactFor(Q, { x: -3.875, y: 0.625, z: 5.5 }, 8) // water -> cool
const PAYLOAD_OFFSET = 13 // Deliberately odd: position i32 begins at offset 19, not aligned.
const IMPACT_OFFSET = 71 // Deliberately odd for the three i32 and three i16 reads too.
const DESTROYED_OFFSET = 43 // Also odd; actor id and XYZ must be read field-by-field.
const bytes = new ArrayBuffer(128)
const view = new DataView(bytes)
const event = { kind: 1, offset: PAYLOAD_OFFSET, byteLength: 24 }
const impactEvent = { kind: 2, offset: IMPACT_OFFSET, byteLength: 22 }
const destroyedEvent = { kind: 5, offset: DESTROYED_OFFSET, byteLength: 18 }

function writeFire(e) {
	const o = PAYLOAD_OFFSET
	view.setUint32(o, e.actor, true)
	view.setUint16(o + 4, e.armament, true)
	view.setInt32(o + 6, wpos(e.x), true)
	view.setInt32(o + 10, wpos(e.z), true) // engine Y -> render Z
	view.setInt32(o + 14, wpos(e.y), true) // engine Z -> render Y
	view.setUint16(o + 18, e.facing, true)
	view.setUint16(o + 20, e.weaponClass, true)
	view.setUint16(o + 22, e.caliber, true)
}

function impactFor(fire, target, surface) {
	const dx = fire.x - target.x
	const dy = fire.y - target.y
	const dz = fire.z - target.z
	const length = Math.hypot(dx, dy, dz)
	return {
		...target,
		nx: dx / length,
		ny: dy / length,
		nz: dz / length,
		surface,
		weaponClass: fire.weaponClass,
		damage: fire.caliber,
	}
}

function writeImpact(e) {
	const o = IMPACT_OFFSET
	view.setInt32(o, wpos(e.x), true)
	view.setInt32(o + 4, wpos(e.z), true) // engine Y -> render Z
	view.setInt32(o + 8, wpos(e.y), true) // engine Z -> render Y
	const nx = falsify === 'incidence-flat' ? 0 : e.nx
	const ny = falsify === 'incidence-flat' ? 1 : e.ny
	const nz = falsify === 'incidence-flat' ? 0 : e.nz
	view.setInt16(o + 12, Math.round(nx * 32767), true)
	view.setInt16(o + 14, Math.round(nz * 32767), true)
	view.setInt16(o + 16, Math.round(ny * 32767), true)
	view.setUint8(o + 18, e.surface)
	view.setUint8(o + 19, falsify === 'pair-zero' ? (e.weaponClass + 1) & 255 : e.weaponClass)
	view.setUint16(o + 20, e.damage, true)
}

function writeDestroyed(e) {
	const o = DESTROYED_OFFSET
	view.setUint32(o, e.actor, true)
	view.setInt32(o + 4, wpos(e.x), true)
	view.setInt32(o + 8, wpos(e.z), true) // engine Y -> render Z
	view.setInt32(o + 12, wpos(e.y), true) // engine Z -> render Y
	view.setUint8(o + 16, e.kind)
	view.setUint8(o + 17, e.violence)
}

const events = new EventBus()
const submitted = []
const lights = []
const uploads = new Map()
let uploaded = null
let tracerUpload = null
let impactUpload = null
let explosionUpload = null
let shroudUnmodelled = false
const hiddenCells = new Set()
const render = {
	// A tracer is sized in PIXELS, so it needs to know how far the camera is: a fixed world
	// radius was under one pixel at gameplay zoom and firing was invisible. The eye sits 24 m
	// up here, an ordinary battle distance, so this fixture exercises the real sizing path.
	camera: { position: new Float32Array([0, 24, 0]) },
	upload(mesh, label) {
		const record = {
			label,
			vertexCount: mesh.vertexCount,
			triangleCount: mesh.triangleCount,
			positions: mesh.positions.slice(0, mesh.vertexCount * 3),
			materialZone: mesh.materialZone.slice(0, mesh.vertexCount),
		}
		uploads.set(label, record)
		return { indexCount: mesh.triangleCount * 3, label }
	},
	submit(item) {
		submitted.push({
			instanceCount: item.instanceCount,
			instances: item.instances.slice(0, item.instanceCount * 16),
			playerColors: item.playerColors,
			castsShadow: item.castsShadow,
			surfaceSet: item.surfaceSet,
			meshLabel: item.mesh.label,
			// Three HDR floats or null. The fallback family must stay null, or an unnamed weapon
			// has silently acquired a colour it never authored.
			emitterColor: item.emitterColor === null || item.emitterColor === undefined
				? null : Array.from(item.emitterColor),
		})
	},
	addLight(x, y, z, r, g, b, intensity, radius) {
		lights.push({ x, y, z, r, g, b, intensity, radius })
	},
}
const shroud = {
	get unmodelled() { return shroudUnmodelled },
	isVisible(x, y) { return !shroudUnmodelled && !hiddenCells.has(`${x},${y}`) },
}
const snapshot = { view, byteLength: view.byteLength }
let destroyedKind = 2
let destroyedAltitude = null
const ctx = {
	// ground-tracks reads the decal budget off the quality preset at init; this fixture has
	// no quality ladder, so it carries the low preset's own number.
	config: { q: { decals: 512 } },
	snapshot,
	events,
	time: { tick: 0, alpha: 0 },
	// The weapon TYPE ID resolves through the same shared string table actor types use — the
	// emitter writes `TypeId(record.Weapon)` — and fx reads it to size a muzzle flash from the
	// authored per-weapon scale. This fixture has no mod behind it, and the empty string is the
	// real answer for that case rather than an error: fx falls back to its damage-derived
	// estimate, which is exactly the path a stale catalogue takes. Omitting the method entirely
	// made the node throw, which is the fixture being incomplete rather than the node being wrong.
	actorTypeName() { return '' },
	// ground-tracks peeks the animation node; this fixture has none, and null is what the
	// registry answers for a clone that never registered one.
	peek: () => null,
	get(id) {
		if (id === 'render') return render
		if (id === 'shroud') return shroud
		if (id === 'units') return { muzzleLiftOf() { return 0 },
			deathKindOf() { return destroyedKind }, deathAltitudeOf() { return destroyedAltitude },
			drainRungTransitions() { } }
		// fx depends on the DRAWN ground, not the simulation's. Playable relief is synthesized in
		// the browser, so an event position taken at face value sits under the hill it happened
		// on: a tracer measured 2.5 m below the surface and was depth-tested away entirely. This
		// fixture returns a flat world, which keeps every existing expectation in this gate
		// unchanged while making the dependency explicit rather than a surprise.
		if (id === 'terrain') return { heightAt() { return 0 } }
		throw new Error(`${TOOL}: fixture requested unexpected dependency ${id}`)
	},
}

const node = new Fx()
node.init(ctx)
uploaded = uploads.get(FLASH_LABEL) ?? null
tracerUpload = uploads.get(TRACER_LABEL) ?? null
// Every authored style must reach the GPU, not just the one this fixture happens to fire. A
// style that meshes to nothing is a weapon family that fires invisibly, and it would otherwise
// only be found by a player.
const muzzleUploads = [...uploads.keys()].filter(label => label.startsWith('fx:muzzle-flash:'))
const tracerUploads = [...uploads.keys()].filter(label => label.startsWith('fx:instant-hit-tracer:'))
if (muzzleUploads.length !== 7)
	note(`${muzzleUploads.length} muzzle styles uploaded, expected the 7 the catalogue names`)
if (tracerUploads.length !== 5)
	note(`${tracerUploads.length} tracer styles uploaded, expected 5 (arc is fx/tesla-arc's)`)
for (const label of [...muzzleUploads, ...tracerUploads]) {
	const record = uploads.get(label)
	if (record.vertexCount <= 0 || record.triangleCount <= 0) note(`${label} meshed to nothing`)
}
impactUpload = uploads.get('fx:impact-burst') ?? null
explosionUpload = uploads.get('fx:actor-destruction') ?? null
if (uploaded === null || uploaded.vertexCount <= 0 || uploaded.triangleCount <= 0)
	note('the boot mesh is empty — a flash would submit invisibly')
if (tracerUpload === null || tracerUpload.vertexCount <= 0 || tracerUpload.triangleCount <= 0)
	note('the instant-hit tracer mesh is empty')
if (impactUpload === null || impactUpload.vertexCount <= 0 || impactUpload.triangleCount <= 0)
	note('the impact-burst mesh is empty')
if (explosionUpload === null || explosionUpload.vertexCount <= 0 || explosionUpload.triangleCount <= 0)
	note('the actor-destruction mesh is empty')

// Packing invariant: an orthogonal source flag must never select a different material layer.
// This cheap comparison catches the entire high-bit-as-layer class without asking a human to
// infer it from a subtly wrong texture in a capture.
for (const layer of Object.values(Zone)) {
	const flagged = withZoneFlag(layer, ZoneFlag.emissive)
	if (materialLayerOf(flagged) !== materialLayerOf(layer))
		note(`Zone.${Object.keys(Zone).find(name => Zone[name] === layer)} changed layer when emissive was set`)
}
for (const source of [
	...[...muzzleUploads, ...tracerUploads].map(label => uploads.get(label)),
	impactUpload, explosionUpload,
]) {
	if (source === null) continue
	let unflagged = 0
	let wrongLayer = 0
	for (const packedZone of source.materialZone) {
		if (!hasZoneFlag(packedZone, ZoneFlag.emissive)) unflagged++
		if (materialLayerOf(packedZone) !== Zone.hull) wrongLayer++
	}
	if (unflagged > 0) note(`${source.label}: ${unflagged}/${source.vertexCount} vertices lack the emissive source flag`)
	if (wrongLayer > 0) note(`${source.label}: ${wrongLayer}/${source.vertexCount} vertices changed away from the hull material layer`)
}

function clearFrame() {
	submitted.length = 0
	lights.length = 0
}

function frame(dt = 1 / 60) {
	clearFrame()
	const ticks = ctx.time.tick + ctx.time.alpha + dt * 25
	ctx.time.tick = Math.floor(ticks)
	ctx.time.alpha = ticks - ctx.time.tick
	node.update(dt, ctx)
}

function emitFire(e) {
	if (falsify === 'zero') return
	writeFire(e)
	events.emit(SimEvent.weaponFire, event)
}

function emitImpact(e) {
	if (falsify === 'zero') return
	writeImpact(e)
	events.emit(SimEvent.projectileImpact, impactEvent)
}

function emitDestroyed(e) {
	if (falsify === 'zero') return
	writeDestroyed(e)
	events.emit(SimEvent.actorDestroyed, destroyedEvent)
}

// 1. Empty is truly free: no phantom DrawItem and no point light.
frame()
if (submitted.length !== 0 || lights.length !== 0)
	note(`empty frame emitted ${submitted.length} draw(s) and ${lights.length} light(s)`)

// 2. Copy two events through the SAME payload bytes before update. If the node retained the
// event or its backing data, both instances would land at B.
emitFire(A)
emitFire(B)
frame()
if (submitted.length !== 1) note(`two flashes produced ${submitted.length} draw submissions, expected one`)
const draw = submitted[0]
if (draw === undefined) {
	note('two visible fire events produced no geometry')
} else {
	if (draw.instanceCount !== 2) note(`one shared draw held ${draw.instanceCount} instances, expected 2`)
	if (draw.castsShadow !== false) note('muzzle flashes cast shadows')
	if (draw.playerColors !== null) note('muzzle flashes entered the player-repaint path')
	if (draw.surfaceSet !== 'foundry') note(`unexpected surface set ${draw.surfaceSet}`)
	if (draw.emitterColor !== null)
		note(`an unnamed weapon acquired an item emitter colour ${draw.emitterColor}; the fallback must keep the engine's own`)

	for (let i = 0; i < Math.min(draw.instanceCount, 2); i++) {
		const e = i === 0 ? A : B
		const o = i * 16
		const m = draw.instances
		const gotPos = [m[o + 12], m[o + 13], m[o + 14]]
		const wantPos = [e.x, e.y, e.z]
		for (let axis = 0; axis < 3; axis++) {
			if (!close(gotPos[axis], wantPos[axis]))
				note(`event ${i} position ${gotPos.map(v => v.toFixed(4))}, expected absolute WPos ${wantPos.map(v => v.toFixed(4))}`)
		}
		const scale = Math.hypot(m[o], m[o + 2])
		// OpenRA is counterclockwise from north; local +X follows the authoritative body heading.
		const yaw = Math.PI * 0.5 + e.facing / 1024 * Math.PI * 2
		if (!close(m[o] / scale, Math.cos(yaw)) || !close(m[o + 2] / scale, -Math.sin(yaw)))
			note(`event ${i} facing ${e.facing} produced the wrong +X basis — a yaw sign or WAngle conversion is wrong`)
		if (!close(m[o + 8] / scale, Math.sin(yaw)) || !close(m[o + 10] / scale, Math.cos(yaw)))
			note(`event ${i} facing ${e.facing} produced the wrong +Z basis`)
	}

	if (draw.instanceCount >= 2) {
		const small = Math.hypot(draw.instances[0], draw.instances[2])
		const large = Math.hypot(draw.instances[16], draw.instances[18])
		if (!(large > small)) note(`caliber ${B.caliber} core scale ${large} did not exceed caliber ${A.caliber} scale ${small}`)
	}
}
if (lights.length !== 2) note(`two visible events emitted ${lights.length} lights, expected 2`)
if (lights.length >= 2) {
	for (let i = 0; i < 2; i++) {
		const l = lights[i]
		const e = i === 0 ? A : B
		if (!close(l.x, e.x) || !close(l.y, e.y) || !close(l.z, e.z))
			note(`event ${i} light moved away from its authoritative muzzle position`)
	}
	if (!(lights[1].intensity > lights[0].intensity && lights[1].radius > lights[0].radius))
		note('larger caliber did not produce a stronger, wider bounded light')
}

// 3. Let both expire, then prove a modelled hidden cell suppresses BOTH information channels.
for (let i = 0; i < 7; i++) frame()
if (node.stats.active !== 0 || submitted.length !== 0 || lights.length !== 0)
	note(`flashes survived beyond their ${(FALLBACK_FLASH_LIFETIME_S * 1000).toFixed(0)} ms lifetime: active=${node.stats.active}`)

shroudUnmodelled = false
hiddenCells.add(`${Math.floor(HIDDEN.x)},${Math.floor(HIDDEN.z)}`)
emitFire(HIDDEN)
frame()
if (submitted.length !== 0 || lights.length !== 0 || node.stats.visible !== 0)
	note(`a hidden fire leaked ${submitted.length} draw(s), ${lights.length} light(s), visible=${node.stats.visible}`)

// 4. The same still-live event remains hidden when the producer does not model shroud.
// Missing visibility fails closed across units, FX, audio and the minimap.
shroudUnmodelled = true
frame()
if (falsify !== 'zero' && (submitted.length !== 0 || lights.length !== 0 || node.stats.visible !== 0))
	note('unmodelled shroud did not fail closed for a still-live flash')

// 5. A truncated record is ignored and diagnosed, never allowed to range-read the snapshot.
for (let i = 0; i < 7; i++) frame()
const malformedBefore = node.stats.malformedEvents
if (falsify !== 'zero') events.emit(SimEvent.weaponFire, { kind: 1, offset: PAYLOAD_OFFSET, byteLength: 8 })
frame()
if (falsify !== 'zero' && node.stats.malformedEvents !== malformedBefore + 1)
	note('a truncated fire record was not counted as malformed')

// 6. Pair an interleaved same-weapon volley by geometry, not FIFO. Both impacts are genuine
// visual subjects even if pairing is falsified: metal selects the warm response and water the
// cool response. The tracer is the only thing a missing pair removes.
for (let i = 0; i < 4; i++) frame()
shroudUnmodelled = false
hiddenCells.clear()
const pairedBefore = node.stats.pairedImpacts
const unpairedBefore = node.stats.unpairedImpacts
emitFire(P)
emitFire(Q)
emitImpact(QI)
emitImpact(PI)
frame()
const flashDraw = submitted.find(s => s.meshLabel === FLASH_LABEL)
const tracerDraw = submitted.find(s => s.meshLabel === TRACER_LABEL)
const warmImpactDraw = submitted.find(s => s.meshLabel === 'fx:impact-burst' && s.surfaceSet === 'foundry')
const coolImpactDraw = submitted.find(s => s.meshLabel === 'fx:impact-burst' && s.surfaceSet === 'lattice')
if (flashDraw?.instanceCount !== 2)
	note(`paired volley retained ${flashDraw?.instanceCount ?? 0} muzzle flashes, expected 2`)
if (tracerDraw?.instanceCount !== 2)
	note(`paired volley emitted ${tracerDraw?.instanceCount ?? 0} tracers, expected 2`)
if (warmImpactDraw?.instanceCount !== 1 || coolImpactDraw?.instanceCount !== 1)
	note(`surface response split warm/cool ${warmImpactDraw?.instanceCount ?? 0}/${coolImpactDraw?.instanceCount ?? 0}, expected 1/1`)
if (falsify !== 'pair-zero' && node.stats.pairedImpacts !== pairedBefore + 2)
	note(`two matchable impacts changed paired count ${pairedBefore} -> ${node.stats.pairedImpacts}`)
if (falsify === 'pair-zero' && node.stats.unpairedImpacts !== unpairedBefore + 2)
	note('pair-zero control did not turn both impacts into explicit unpaired bursts')

if (tracerDraw !== undefined && tracerDraw.instanceCount >= 2) {
	// Impact order is Q then P, so source translation and the local +X column name exactly
	// which fire each endpoint matched. A FIFO implementation fails both records.
	for (let i = 0; i < 2; i++) {
		const fire = i === 0 ? Q : P
		const impact = i === 0 ? QI : PI
		const o = i * 16
		const m = tracerDraw.instances
		const source = [m[o + 12], m[o + 13], m[o + 14]]
		const delta = [m[o], m[o + 1], m[o + 2]]
		const wantDelta = [impact.x - fire.x, impact.y - fire.y, impact.z - fire.z]
		if (!source.every((value, axis) => close(value, [fire.x, fire.y, fire.z][axis], 1e-4)))
			note(`tracer ${i} began at ${source.map(v => v.toFixed(4))}, expected ${fire.x},${fire.y},${fire.z}`)
		// The tracer is a DASH that walks the path, not a beam spanning it: drawing the whole
		// muzzle-to-impact line at once is what read as a laser. So the contract is that the
		// streak lies exactly ON the path -- same direction, no fabricated bearing -- and is a
		// bounded fraction of it, rather than that it reaches the impact in one frame.
		const wantLen = Math.hypot(...wantDelta)
		const gotLen = Math.hypot(...delta)
		const dot = wantLen > 1e-6 && gotLen > 1e-6
			? delta.reduce((sum, v, axis) => sum + v * wantDelta[axis], 0) / (wantLen * gotLen) : 0
		if (dot < 0.9999)
			note(`tracer ${i} +X ${delta.map(v => v.toFixed(4))} does not lie along the path ` +
				`${wantDelta.map(v => v.toFixed(4))} (cos ${dot.toFixed(5)})`)
		const wantStreak = Math.min(
			wantLen * TRACER_STREAK_FRACTION[FALLBACK_TRACER_STYLE],
			TRACER_STREAK_MAX_M[FALLBACK_TRACER_STYLE])
		if (!close(gotLen, wantStreak, Math.max(1e-3, wantStreak * 0.02)))
			note(`tracer ${i} streak is ${gotLen.toFixed(4)} m of a ${wantLen.toFixed(4)} m path, ` +
				`expected ${wantStreak.toFixed(4)}`)
	}
}

for (const [draw, impact, name] of [
	[warmImpactDraw, PI, 'metal'],
	[coolImpactDraw, QI, 'water'],
]) {
	if (draw === undefined || draw.instanceCount < 1) continue
	const m = draw.instances
	const scale = Math.hypot(m[0], m[1], m[2])
	const got = [m[0] / scale, m[1] / scale, m[2] / scale]
	const want = [impact.nx, impact.ny, impact.nz]
	if (!got.every((value, axis) => close(value, want[axis], 2e-4)))
		note(`${name} impact burst incidence ${got.map(v => v.toFixed(4))}, expected impact-to-source ${want.map(v => v.toFixed(4))}`)
}

// 7. An impact with no eligible fire still bursts at the hit point but never draws a tracer
// to (0,0,0). This is the degradation contract for dropped, old or unsupported fire records.
// Enough frames to outlive a tracer, whose life is now 0.26 s rather than 0.075 s: at 12 frames
// a tracer from the paired volley above was still on screen and got counted as fabricated here.
for (let i = 0; i < 40; i++) frame()
const solo = impactFor(
	{ x: 9, y: 3, z: -2, weaponClass: 84, caliber: 90 },
	{ x: 1.25, y: 0.5, z: -7.75 },
	7,
)
const soloUnpairedBefore = node.stats.unpairedImpacts
const soloTracersBefore = node.stats.startedTracers
emitImpact(solo)
frame()
// Count tracers STARTED, not tracers on screen. A live tracer left over from an earlier case is
// not evidence that this impact fabricated one, and the longer lifetime makes leftovers normal.
if (node.stats.startedTracers !== soloTracersBefore)
	note('an unpaired impact drew a tracer to a fabricated source')
if (!submitted.some(s => s.meshLabel === 'fx:impact-burst'))
	note('an unpaired impact lost its authoritative impact burst')
if (falsify !== 'zero' && node.stats.unpairedImpacts !== soloUnpairedBefore + 1)
	note('an unpaired impact was not diagnosed')

// 8. Truncated impact payloads are rejected independently of fire payloads.
for (let i = 0; i < 9; i++) frame()
const malformedImpactBefore = node.stats.malformedEvents
if (falsify !== 'zero') events.emit(SimEvent.projectileImpact, { kind: 2, offset: IMPACT_OFFSET, byteLength: 12 })
frame()
if (falsify !== 'zero' && node.stats.malformedEvents !== malformedImpactBefore + 1)
	note('a truncated impact record was not counted as malformed')

// 9. Actor destruction is an independent authoritative effect. It is centred on the event
// WPos, scales with violence, lasts across frames and never casts a shadow.
for (let i = 0; i < 9; i++) frame()
const destroyedAcceptedBefore = node.stats.acceptedDestroyedEvents
emitDestroyed(DESTROYED)
frame()
const destructionDraw = submitted.find(s => s.meshLabel === 'fx:actor-destruction')
if (falsify !== 'zero') {
	if (node.stats.acceptedDestroyedEvents !== destroyedAcceptedBefore + 1)
		note('the authoritative actor-destroyed record was not accepted')
	if (destructionDraw?.instanceCount !== 1)
		note(`one actor destruction produced ${destructionDraw?.instanceCount ?? 0} cores, expected 1`)
	else {
		const m = destructionDraw.instances
		if (!close(m[12], DESTROYED.x) || !close(m[13], DESTROYED.y) || !close(m[14], DESTROYED.z))
			note(`destruction moved away from authoritative WPos: ${m[12]},${m[13]},${m[14]}`)
		if (destructionDraw.castsShadow !== false) note('actor-destruction geometry casts shadows')
	}
	if (!lights.some(l => close(l.x, DESTROYED.x) && close(l.z, DESTROYED.z)))
		note('actor destruction emitted no bounded light at its authoritative position')
}

// Hidden deaths must not reveal a unit through either geometry or light. Lifetime continues
// behind shroud, so revealing the cell after expiry cannot replay the event.
for (let i = 0; i < 28; i++) frame()
for (const kind of [0, 1, 3]) {
	destroyedKind = kind
	emitDestroyed(DESTROYED)
	frame()
	if (submitted.some(s => s.meshLabel === 'fx:actor-destruction') || lights.length)
		note(`living actor kind ${kind} incorrectly emitted a vehicle fireball/light`)
}
destroyedKind = 2
destroyedAltitude = 10.5
emitDestroyed(DESTROYED)
frame()
if (falsify !== 'zero' && !submitted.some(s => s.meshLabel === 'fx:actor-destruction' && close(s.instances[13], 10.5)))
	note('aircraft destruction ignored its captured displayed altitude above reconstructed mountains')
destroyedAltitude = null
for (let i = 0; i < 28; i++) frame()
shroudUnmodelled = false
hiddenCells.add(`${Math.floor(DESTROYED.x)},${Math.floor(DESTROYED.z)}`)
emitDestroyed(DESTROYED)
frame()
if (falsify !== 'zero' && (
	submitted.some(s => s.meshLabel === 'fx:actor-destruction') ||
	lights.some(l => close(l.x, DESTROYED.x) && close(l.z, DESTROYED.z))
)) note('a hidden actor destruction leaked geometry or light')
shroudUnmodelled = true
hiddenCells.clear()

const malformedDestroyedBefore = node.stats.malformedEvents
if (falsify !== 'zero') events.emit(SimEvent.actorDestroyed, { kind: 5, offset: DESTROYED_OFFSET, byteLength: 12 })
frame()
if (falsify !== 'zero' && node.stats.malformedEvents !== malformedDestroyedBefore + 1)
	note('a truncated actor-destroyed record was not counted as malformed')

// --- diagnostic measurements ----------------------------------------------------

// Authored fixture height, not an FX dependency. This number is observational: production
// keeps engine Z verbatim. A slope-dependent drift in it would expose disagreement between
// the engine and web height reconstructions rather than being hidden by a clamp.
const slopedGround = (x, z) => 0.2 * x - 0.15 * z + 0.4
const groundDelta = A.y - slopedGround(A.x, A.z)

// Pinned-camera support bounds. The mesh number is the geometric core; the light number is the
// maximum region that can receive radiance. This is not an image threshold and is not used as
// a correctness assertion — capture is the real pixel witness — but it makes the far-camera
// visual weighting explicit and repeatable.
let meshSpanPx = 0
let lightSpanPx = 0
if (uploaded !== null && draw !== undefined && draw.instanceCount > 0 && lights.length === 0) {
	// The recorded light frame was cleared during lifetime checks; reconstruct only its bounded
	// radius from the same public caliber relation the gate observed above.
	const root = Math.sqrt(Math.min(Math.max(A.caliber, 1), 512))
	const radius = 2.4 + root * 0.11
	const W = 960, H = 540
	const eye = vec3(0, 16, 22)
	const viewM = m4.lookAt(mat4(), eye, vec3(A.x, A.y, A.z), vec3(0, 1, 0))
	const projM = m4.perspectiveReverseZ(mat4(), 50 * Math.PI / 180, W / H, 0.1)
	const vp = m4.multiply(mat4(), projM, viewM)
	const project = (x, y, z) => {
		const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
		return [
			((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw * 0.5 + 0.5) * W,
			(0.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw * 0.5) * H,
		]
	}
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
	const m = draw.instances
	for (let i = 0; i < uploaded.positions.length; i += 3) {
		const lx = uploaded.positions[i], ly = uploaded.positions[i + 1], lz = uploaded.positions[i + 2]
		const x = m[0] * lx + m[4] * ly + m[8] * lz + m[12]
		const y = m[1] * lx + m[5] * ly + m[9] * lz + m[13]
		const z = m[2] * lx + m[6] * ly + m[10] * lz + m[14]
		const p = project(x, y, z)
		minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0])
		minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1])
	}
	meshSpanPx = Math.max(maxX - minX, maxY - minY)
	const center = project(A.x, A.y, A.z)
	const edgeX = project(A.x + radius, A.y, A.z)
	const edgeY = project(A.x, A.y + radius, A.z)
	lightSpanPx = 2 * Math.max(Math.hypot(edgeX[0] - center[0], edgeX[1] - center[1]), Math.hypot(edgeY[0] - center[0], edgeY[1] - center[1]))
}

// --- production presented-pixel witness ----------------------------------------
//
// The headless assertions above drive the real node but stub the renderer. That is not enough:
// this project has had a forward pipeline fail to build while every numeric gate stayed green.
// Inject the same wire record into the live production app and compare three pinned-camera
// frames. The ordinary dev snapshot has no fire records, so a generic capture only proves FX
// boot; this is the draw-path witness.
let visual = null
if (falsify !== 'zero' && problems.length === 0) {
	let browser = null
	let server = null
	try {
		const chromium = await loadChromium(TOOL)
		const launched = await launchGpuBrowser(chromium, TOOL)
		browser = launched.browser
		if (launched.warning) console.warn(launched.warning)
		const preview = await startPreview(8392)
		server = preview.server
		const context = await browser.newContext({
			viewport: { width: 960, height: 540 },
			deviceScaleFactor: 1,
			locale: 'en-US',
			timezoneId: 'UTC',
		})
		const page = await context.newPage()
		const pageErrors = []
		page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`))
		page.on('console', message => {
			if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
				pageErrors.push(`console.error: ${message.text()}`)
		})
		await page.addInitScript(({ defeatEmission }) => {
			let next = 1
			globalThis.requestAnimationFrame = () => next++
			globalThis.cancelAnimationFrame = () => {}

			const state = { replacements: 0, forward: 0, blend: 0 }
			globalThis.__fxgateEmissive = state
			if (!defeatEmission) return
			const deviceProto = globalThis.GPUDevice?.prototype
			if (deviceProto == null) return
			const realModule = deviceProto.createShaderModule
			deviceProto.createShaderModule = function fxgateShader(desc) {
				let code = String(desc.code)
				if (desc.label === 'render.forward' || desc.label === 'render.forward.blend') {
					const nextCode = code.replace(
						'const SURFACE_EMISSIVE_INTENSITY: f32 = 3.00;',
						'const SURFACE_EMISSIVE_INTENSITY: f32 = 0.00;',
					)
					if (nextCode !== code) {
						code = nextCode
						state.replacements++
						if (desc.label === 'render.forward') state.forward++
						else state.blend++
					}
				}
				return realModule.call(this, { ...desc, code })
			}
		}, { defeatEmission: falsify === 'emissive-zero' })
		const url = new URL(preview.baseUrl)
		url.searchParams.set('devmap', '1')
		url.searchParams.set('deterministic', '1')
		url.searchParams.set('manual', '1')
		url.searchParams.set('seed', 'steelseed-fx-visual-v1')
		url.searchParams.set('devsize', '96')
		// Spawn the armed, authored-visual artillery archetype: the production fire path
		// refuses a record whose shooter it cannot place a muzzle for, and the default
		// fixture's synthetic probes carry no armaments (see the shooter scan below).
		url.searchParams.set('devtypes', 'arty')
		url.searchParams.set('quality', 'high')
		await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(
			() => globalThis.steelseed !== undefined,
			undefined,
			{ timeout: 120000, polling: 100 },
		).catch(error => {
			throw new Error(`${error.message}${pageErrors[0] ? `; ${pageErrors[0]}` : ''}`)
		})

		visual = await page.evaluate(() => {
			const app = globalThis.steelseed
			app.stop()
			const render = app.registry.peek('render')
			const camera = app.registry.peek('camera')
			const terrain = app.registry.peek('terrain')
			const fx = app.registry.peek('fx')
			const device = app.ctx.device
			if (render == null || camera == null || terrain == null || fx == null)
				throw new Error('fx visual fixture could not reach render, camera, terrain or fx')
			if (app.ctx.backend !== 'webgpu' || device == null)
				throw new Error(`fx visual fixture requires WebGPU; backend=${app.ctx.backend}`)

			let frame = 0
			for (let i = 0; i < 8; i++) app.renderOneFrame(frame++ * (1000 / 60))
			const snap = app.ctx.snapshot
			const world = snap?.world
			const actors = snap?.actors
			if (world == null || actors == null || actors.count === 0)
				throw new Error('fx visual fixture has no world or actors')
			// From here all three images see identical simulation state. Only the injected flash
			// differs; a new bridge tick would move the whole army and flatter the pixel diff.
			app.bridge.pollSnapshot = () => null
			// THE FIRE RECORD MUST NAME A REAL, DRAWN, ARMED ACTOR. The production fire path
			// places the flash on the firing actor's authored barrel tip (`units.muzzleWorldOf`)
			// and deliberately refuses a record whose source it cannot place — a missing or
			// hidden shooter must never manufacture a flash at a generic payload position. The
			// dev fixture's default synthetic probes carry no armaments, so the witness used to
			// inject actor 41 (which does not exist) and every capture pair came back identical.
			// Boot with ?devtypes=arty (see the URL above) and scan for an actor whose muzzle
			// production actually places; the placed barrel tip is the geometry anchor for the
			// camera, the impact and the incidence axis from here on.
			const units = app.registry.peek('units')
			const muzzleScratch = new Float32Array(6)
			let shooterId = 0
			let shooterArm = 0
			for (let i = 0; i < actors.count && shooterId === 0; i++) {
				const id = actors.id[i]
				const px = actors.posX[i] / 1024
				const py = actors.posY[i] / 1024
				for (let arm = 0; arm < 8 && shooterId === 0; arm++) {
					muzzleScratch.fill(0)
					let placed = false
					try { placed = units?.muzzleWorldOf?.(id, arm, px, py, 0, muzzleScratch) ?? false } catch { placed = false }
					if (placed && Number.isFinite(muzzleScratch[0])) { shooterId = id; shooterArm = arm }
				}
			}
			if (shooterId === 0)
				throw new Error('fx visual fixture has no drawn armed actor for the production fire path')
			const x = muzzleScratch[0]
			const y = muzzleScratch[1]
			const z = muzzleScratch[2]
			camera.target.set([x, terrain.heightAt(x, z), z])
			camera.targetGoal.set([x, terrain.heightAt(x, z), z])
			camera.height = 18
			camera.heightGoal = 18
			camera.yaw = 0.55
			camera.yawGoal = 0.55
			camera.boundsKnown = true
			camera.boundsMinX = world.boundsLeft
			camera.boundsMaxX = world.boundsRight
			camera.boundsMinZ = world.boundsTop
			camera.boundsMaxZ = world.boundsBottom
			document.getElementById('boot')?.setAttribute('hidden', '')
			render.probes.updatesPerFrame = 0

			// The strike sits a few metres down-range of the placed muzzle and the incidence
			// axis points from the strike back at it, so the geometric pair test (dot > 0.995)
			// matches the fire record production will have created at exactly this muzzle. The
			// impact payload's Y is the sim-relative height the reader adds
			// `presentationHeightOffsetAt ?? heightAt` on top of — mirror that expression, or
			// the drawn strike floats and the axis dot falls under the pairing floor.
			let fwx = muzzleScratch[3], fyw = muzzleScratch[4], fwz = muzzleScratch[5]
			const forwardLength = Math.hypot(fwx, fyw, fwz)
			if (forwardLength > 1e-6) { fwx /= forwardLength; fyw /= forwardLength; fwz /= forwardLength }
			else { fwx = 1; fyw = 0; fwz = 0 }
			const sideX = -fwz, sideZ = fwx
			const sideLength = Math.hypot(sideX, sideZ) || 1
			const impactX = x + fwx * 4.5 + (sideX / sideLength) * 1.1
			const impactZ = z + fwz * 4.5 + (sideZ / sideLength) * 1.1
			const impactBase = terrain.presentationHeightOffsetAt?.(impactX, impactZ) ?? terrain.heightAt?.(impactX, impactZ) ?? 0
			const impactY = y - 0.25 - impactBase
			const strikeY = impactY + impactBase
			const incidenceLength = Math.hypot(x - impactX, y - strikeY, z - impactZ)
			const incidenceX = (x - impactX) / incidenceLength
			const incidenceY = (y - strikeY) / incidenceLength
			const incidenceZ = (z - impactZ) / incidenceLength
			// WEAPON CLASS 200, not 19.
			//
			// The dev map's shared string table is the STEELSEED archetype roster — id 19 is
			// `foundry_cupola`, a building — and the weapon catalogue is keyed on RA weapon
			// names, so id 19 resolved to a real NAME with no profile behind it. That is not the
			// "no table yet" case the fallback exists for: `lookupRaWeaponVisual` answers UNKNOWN,
			// whose authored `muzzle.scaleM` is 0, and a zero scale correctly draws no flash. So
			// this witness was measuring a weapon that is supposed to be invisible, and its
			// muzzle number was whatever the pre-b05dac9 build happened to draw before zero-scale
			// weapons were made silent. 200 is past the ?devtypes=arty table's single entry, so
			// the name really is empty and `styleFor(200)` really is unresolved. (The SHOOTER's
			// own armament name, 155mm, does resolve — the flash and paired tracer are the
			// authored heavy/artillery profile — but the impact payload's u8 weapon byte stays
			// unnamed, which is the record shape an instant hit actually leaves behind.)
			const WEAPON = 200
			const injectFire = () => {
				const v = snap.view
				const o = v.byteLength - 52
				v.setUint32(o, shooterId, true)
				v.setUint16(o + 4, shooterArm, true)
				v.setInt32(o + 6, Math.round(x * 1024), true)
				v.setInt32(o + 10, Math.round(z * 1024), true)
				v.setInt32(o + 14, Math.round(y * 1024), true)
				v.setUint16(o + 18, 137, true)
				v.setUint16(o + 20, WEAPON, true)
				v.setUint16(o + 22, 400, true)
				app.events.emit('sim:weapon:fire', { kind: 1, offset: o, byteLength: 24 })
			}
			const injectImpact = () => {
				const v = snap.view
				const o = v.byteLength - 24
				v.setInt32(o, Math.round(impactX * 1024), true)
				v.setInt32(o + 4, Math.round(impactZ * 1024), true)
				v.setInt32(o + 8, Math.round(impactY * 1024), true)
				v.setInt16(o + 12, Math.round(incidenceX * 32767), true)
				v.setInt16(o + 14, Math.round(incidenceZ * 32767), true)
				v.setInt16(o + 16, Math.round(incidenceY * 32767), true)
				v.setUint8(o + 18, 6) // metal — warm surface response
				v.setUint8(o + 19, WEAPON)
				v.setUint16(o + 20, 400, true)
				app.events.emit('sim:projectile:impact', { kind: 2, offset: o, byteLength: 22 })
			}
			const clearFx = () => {
				fx.count = 0
				fx.tracerCount = 0
				fx.impactCount = 0
				fx.explosionCount = 0
			}
			const injectDestroyed = () => {
				const v = snap.view
				const o = v.byteLength - 84
				const units = app.registry.peek('units')
				let id = null
				for (const candidate of snap.actors.id) {
					const kind = units.deathKindOf(candidate)
					if (kind === 2 || kind === 4) { id = candidate; break }
				}
				if (id === null) throw Error('destruction witness needs an actually drawn non-organic actor')
				v.setUint32(o, id, true)
				v.setInt32(o + 4, Math.round(impactX * 1024), true)
				v.setInt32(o + 8, Math.round(impactZ * 1024), true)
				// The destroyed payload's Y is read verbatim (no terrain offset added), so it
				// carries the absolute barrel-tip height, not the impact payload's sim-relative one.
				v.setInt32(o + 12, Math.round((y - 0.25) * 1024), true)
				v.setUint8(o + 16, 0)
				v.setUint8(o + 17, 211)
				app.events.emit('sim:actor:destroyed', { kind: 5, offset: o, byteLength: 18 })
			}

			const capture = () => {
				// Deterministic mode still advances elapsed time on every call. Reset the public
				// clock fields so water, wind and interpolation cannot masquerade as FX pixels.
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
				if (g == null) throw new Error('fx visual fixture could not create a 2D capture context')
				g.drawImage(source, 0, 0)
				return new Uint8ClampedArray(g.getImageData(0, 0, copy.width, copy.height).data)
			}
			const compare = (a, b) => {
				let changed = 0, sum = 0, max = 0
				for (let i = 0; i < a.length; i += 4) {
					const d = Math.max(
						Math.abs(a[i] - b[i]),
						Math.abs(a[i + 1] - b[i + 1]),
						Math.abs(a[i + 2] - b[i + 2]),
					)
					if (d > 1) changed++
					sum += d
					max = Math.max(max, d)
				}
				return { changed, sum, max }
			}

			// Baseline has no FX. One discarded capture absorbs one-shot settling (boot fade,
			// first-capture state) so the noise pair measures steady state, not warm-up.
			clearFx()
			capture()
			const baselineA = capture()
			const baseline = capture()
			injectFire()
			const originalSubmit = render.submit.bind(render)
			const meshLabel = item => String(item?.mesh?.label ?? '')
			// Hold EVERY muzzle-flash mesh out of only this frame (the flash draws through a
			// per-family item, so the old single `fx.item` handle missed authored weapons) to
			// measure light-only through the production clustered-light path.
			render.submit = item => { if (meshLabel(item).startsWith('fx:muzzle-flash:')) return; originalSubmit(item) }
			const lightOnly = capture()
			render.submit = originalSubmit
			// Reset the test-owned transient and replay the exact payload. This is deliberately
			// gate-local state surgery, never a production API: it isolates one mesh over one light.
			clearFx()
			injectFire()
			const combined = capture()
			// Pair the same authoritative fire with a real impact. Suppress the impact bursts by
			// mesh label to isolate the tracer, then replay once more with all production geometry.
			clearFx()
			injectFire()
			injectImpact()
			render.submit = item => { if (meshLabel(item) === 'fx:impact-burst') return; originalSubmit(item) }
			const withTracer = capture()
			render.submit = originalSubmit
			clearFx()
			injectFire()
			injectImpact()
			const withImpact = capture()
			clearFx()
			injectDestroyed()
			const withDestruction = capture()
			return {
				noise: compare(baselineA, baseline),
				lightOnly: compare(baseline, lightOnly),
				combined: compare(baseline, combined),
				meshContribution: compare(lightOnly, combined),
				tracerContribution: compare(combined, withTracer),
				impactContribution: compare(withTracer, withImpact),
				fullContribution: compare(combined, withImpact),
				destructionContribution: compare(baseline, withDestruction),
				nonBlack: withDestruction.reduce((n, value, i) => i % 4 !== 3 && value > 0 ? n + 1 : n, 0),
				shaderControl: { ...globalThis.__fxgateEmissive },
			}
		})
		if (pageErrors.length > 0) problems.push(...pageErrors)
		if (visual.lightOnly.changed < visual.noise.changed + 20)
			problems.push(`production light changed ${visual.lightOnly.changed} pixels against ${visual.noise.changed} baseline noise; the far-camera signal does not read`)
		if (visual.combined.changed < visual.noise.changed + 20)
			problems.push(`production light+mesh changed ${visual.combined.changed} pixels against ${visual.noise.changed} baseline noise`)
		// Preserve the exact pre-channel production metric. The new source must beat 107 pixels
		// on the identical fixture; the zero-intensity control leaves placement, area, light and
		// DrawItem untouched and therefore goes red at the old 107-pixel result.
		if (visual.meshContribution.changed <= 107)
			problems.push(`the production emissive mesh changed ${visual.meshContribution.changed} pixels over light-only; it did not beat the pinned 107/1424 baseline`)
		if (visual.tracerContribution.changed < 20)
			problems.push(`the production tracer changed only ${visual.tracerContribution.changed} pixels over the muzzle-only frame`)
		if (visual.impactContribution.changed < 10)
			problems.push(`the production impact burst changed only ${visual.impactContribution.changed} pixels over tracer+muzzle`)
		if (visual.destructionContribution.changed < 80)
			problems.push(`the production actor destruction changed only ${visual.destructionContribution.changed} pixels against baseline`)
		const expectedReplacements = falsify === 'emissive-zero' ? 2 : 0
		if (visual.shaderControl.replacements !== expectedReplacements)
			problems.push(`emissive control made ${visual.shaderControl.replacements} shader replacements, expected ${expectedReplacements}`)
		if (falsify === 'emissive-zero' && (visual.shaderControl.forward !== 1 || visual.shaderControl.blend !== 1))
			problems.push(`emissive control patched forward/blend ${visual.shaderControl.forward}/${visual.shaderControl.blend}, expected 1/1`)
		if (visual.nonBlack === 0) problems.push('the production FX frame is black')
	} catch (error) {
		problems.push(`production visual witness failed: ${error.message}`)
	} finally {
		if (browser != null) await browser.close().catch(() => {})
		if (server != null) await stopChild(server).catch(() => {})
	}
}

const label = falsify === null ? '' : ` (--falsify=${falsify})`
console.log(
	`${TOOL}: meshes flash/tracer/impact/destruction ${uploaded?.vertexCount ?? 0}/${tracerUpload?.vertexCount ?? 0}/${impactUpload?.vertexCount ?? 0}/${explosionUpload?.vertexCount ?? 0} vertices, ` +
	`fallback flash ${(FALLBACK_FLASH_LIFETIME_S * 1000).toFixed(0)} ms, impact 110 ms, destruction 420 ms; ` +
	`${muzzleUploads.length} muzzle styles and ${tracerUploads.length} tracer styles uploaded${label}`,
)
console.log(`${TOOL}: sloped-cell muzzle minus fixture ground ${groundDelta.toFixed(4)} m (observation only; event Z preserved)`)
console.log(`${TOOL}: pinned-camera support light-only ${lightSpanPx.toFixed(2)} px, mesh core ${meshSpanPx.toFixed(2)} px, light+mesh ${Math.max(lightSpanPx, meshSpanPx).toFixed(2)} px`)
if (visual !== null)
	console.log(
		`${TOOL}: production pixels noise ${visual.noise.changed}, light-only ${visual.lightOnly.changed}, muzzle ${visual.combined.changed}, ` +
		`muzzle mesh ${visual.meshContribution.changed}, tracer +${visual.tracerContribution.changed}, impact +${visual.impactContribution.changed}, ` +
		`destruction ${visual.destructionContribution.changed}, full delta ${visual.fullContribution.changed}; max channels ${visual.lightOnly.max}/${visual.combined.max}; ` +
		`shader replacements ${visual.shaderControl.replacements} (${visual.shaderControl.forward}/${visual.shaderControl.blend})`,
	)
if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — instant-hit FX do not preserve event pairing, incidence, surface, visibility or emission.`)
	process.exit(1)
}
console.log(
	`${TOOL}: PASS — fire/impact payloads are copied, same-weapon volleys pair geometrically, ` +
	`unpaired fire stays muzzle-only, and surface-voiced incidence bursts are visible. ` +
	`authoritative deaths produce shroud-safe volumetric destruction. No decal ships: §4.9 carries incidence, not a struck-surface normal.`,
)
