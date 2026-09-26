#!/usr/bin/env node
// STEELSEED — tools/audionodegate
//
// `audiogate` proves what a sound is SHAPED like. Nothing proved where it is PUT.
//
// That is the half with the integration bugs in it. The one real defect found while building
// this node was of exactly that kind: `update()` panned the movement mix against a listener
// basis that only `play()` ever computed, so it used whatever the last gunshot happened to
// leave behind — or all zeros in a battle where nothing had fired yet. `audiogate` could not
// have seen it. It is not in a waveform.
//
// So this gate drives the REAL `Audio` class against a stub AudioContext and a stub Ctx, and
// asserts the placement contract:
//
//   1  a fire event produces exactly one scheduled source
//   2  it is DELAYED by distance / 343 m/s        (the depth cue, and it is easy to drop silently)
//   3  it is ATTENUATED by distance               (inverse-square against the reference distance)
//   4  it PANS by which side of the listener it is on, and pans the OTHER way on the other side
//   5  §4.7 — a sound inside the fog does not play at all
//   6  pool exhaustion DROPS and counts, and never steals
//   7  a malformed/short payload is ignored rather than read past
//   8  movement weight lands on the SURFACE THE ACTOR IS STANDING ON
//   9  a stationary actor contributes nothing
//  10  A SHOT PLAYS ITS OWN WEAPON'S VOICE — the buffer a fire event reaches is the one its
//      family names, and the join survives the casing the host actually publishes
//  11  the per-shot variation is a PURE FUNCTION of the shot, not of how many shots preceded it
//
// 10 and 11 are new and are the placement half of the defect the bank was rebuilt for. A
// perfect twelve-family bank is worth nothing if `handleFire` reaches the wrong row of it, and
// the two ways that happens are both invisible from a waveform: the host publishes a weapon
// name in a casing the table does not hold, or it publishes no string table at all. Both
// degrade to "every weapon is a cannon", which is exactly what the game sounded like before
// and produces no error anywhere. `--falsify=nocase` and `--falsify=notypetable` are those two.
//
// NO BROWSER AND NO AUDIO HARDWARE. §14.8's promise was that audio would be gateable without
// the GPU-Chromium harness; a stub context keeps that true for the scheduling half as well.
// The stub is deliberately dumb — it records, it does not simulate. A stub that tried to model
// Web Audio would become a second implementation to get wrong.
//
// Usage:
//   node tools/audionodegate.mjs [--falsify=nodelay|noshroud|nopan|notypetable|nocase]

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'audionodegate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const falsify = (argv.find(a => a.startsWith('--falsify=')) ?? '').slice(10) || null
const FALSIFIERS = ['nodelay', 'noshroud', 'nopan', 'notypetable', 'nocase']
if (falsify !== null && !FALSIFIERS.includes(falsify)) {
	console.error(`${TOOL}: unknown --falsify=${falsify} (expected one of ${FALSIFIERS.join(', ')})`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'audionodegate-'))
const bundlePath = join(tmp, 'audio.mjs')
await esbuild({
	entryPoints: [resolve(WEB, 'src/audio/index.gate.ts')],
	bundle: true, format: 'esm', platform: 'neutral', outfile: bundlePath, logLevel: 'silent',
})
const { Audio, reportBand } = await import(bundlePath)

const problems = []
const fail = (m) => problems.push(m)
const SAMPLE_RATE = 48000
const SPEED_OF_SOUND = 343

// ---------------------------------------------------------------------------
// Stubs. Recording, not simulating.
// ---------------------------------------------------------------------------

const started = []

function makeParam(v) { return { value: v } }

let ctxRef = null

class StubContext {
	constructor() {
		ctxRef = this
		this.sampleRate = SAMPLE_RATE
		this.state = 'running'
		this.currentTime = 100
		this.destination = { connect() {} }
	}
	createGain() { return { gain: makeParam(1), connect() {} } }
	createStereoPanner() {
		// `--falsify=nopan` makes the panner ignore every write. Perturbing at the STUB
		// boundary rather than inside the node is deliberate and is stated so it cannot be
		// mistaken for rigour it does not have: it models a node that never places a sound,
		// which is what a dropped or constant pan looks like from outside. It proves the
		// assertion has teeth; it does not prove the node computes pan the right way, which is
		// what the opposite-signs check is for.
		const pan = falsify === 'nopan'
			? { get value() { return 0 }, set value(_v) { /* discarded */ } }
			: makeParam(0)
		return { pan, connect() {} }
	}
	createBiquadFilter() { return { type: '', frequency: makeParam(0), connect() {} } }
	createBuffer(_ch, len, rate) {
		const data = new Float32Array(len)
		return { length: len, sampleRate: rate, duration: len / rate, getChannelData: () => data, copyToChannel: a=>data.set(a) }
	}
	createBufferSource() {
		const src = {
			buffer: null, loop: false, playbackRate: makeParam(1),
			_gain: null,
			connect(node) { src._gain = node },
			start(when) {
				// `--falsify=nodelay` discards the scheduled time, which is exactly what a node
				// calling `start()` with no argument — or with `currentTime` — would produce.
				const at = falsify === 'nodelay' ? ctxRef.currentTime : (when ?? 0)
				started.push({ src, when: at, t0: ctxRef.currentTime, gain: src._gain })
			},
			stop() {},disconnect() {},
		}
		return src
	}
	resume() { this.state = 'running' }
	close() {}
}

/** The chain is gain -> pan -> lp, so a recorded source's placement is read back through it. */
function chainOf(entry) {
	// The stub's createGain returns a bare object; the node wires gain.connect(pan) etc., but
	// the stub does not retain those links. Placement is therefore read from the node's own
	// slot list, which is what the assertions below use.
	return entry
}
void chainOf

let listenerEye = new Float32Array([0, 30, 0])
let listenerFocus = new Float32Array([0, 0, 0])
let shroudVisible = true

const stubs = {
	camera: {
		get listenerEye() { return listenerEye },
		get listenerFocus() { return listenerFocus },
	},
	shroud: {
		unmodelled: false,
		isVisible: () => (falsify === 'noshroud' ? true : shroudVisible),
	},
}

/** One 64 KiB buffer standing in for the snapshot; events point into it by offset. */
const snapBuf = new ArrayBuffer(65536)
const snapView = new DataView(snapBuf)
const snapshot = { view: snapView, actors: null, tick: 0 }

/**
 * The host's shared string table, stubbed with REAL weapon names out of the generated table.
 *
 * A fire event carries a u16 index into this, not a weapon; `SnapshotEmitter.cs:796` writes
 * `TypeId(record.Weapon)` and the node resolves it back through `ctx.actorTypeName`. Feeding
 * the gate invented names would test a lookup against itself, so the ids here are assigned from
 * `weapon-audio.json` in the order the host would first see them.
 *
 * `TYPE_TABLE_CASE` is the switch that matters. `Ruleset.Weapons` lowercases its keys, and a
 * live match has already been observed publishing "dragon" where the catalogue holds "Dragon" —
 * which silently discarded every row it matched against and produced no error anywhere. This
 * stub can publish either casing, and the assertions below demand the same family from both.
 */
const ROSTER = JSON.parse(readFileSync(resolve(WEB, 'src/audio/weapon-audio.json'), 'utf8'))
const WEAPON_NAMES = Object.keys(ROSTER.weapons)
let typeTableCase = 'authored'
function weaponTypeId(name) { return WEAPON_NAMES.indexOf(name) + 1000 }
function actorTypeName(typeId) {
	const name = WEAPON_NAMES[typeId - 1000]
	if (name === undefined) return ''
	if (typeTableCase === 'lower') return name.toLowerCase()
	// `mangled` publishes a name the table cannot hold in ANY casing. It is the control for the
	// join assertion below, and what it models is stated plainly rather than overclaimed: it
	// proves the assertion detects a join that failed, which is the failure mode — the host
	// sending a name this node cannot resolve, and every shot quietly becoming a cannon. It
	// does NOT prove the assertion detects case-sensitivity specifically, because that would
	// require perturbing the node's own lookup rather than the stub, and a falsifier that edits
	// the thing under test proves nothing about it. Same reasoning as `--falsify=nopan`.
	if (typeTableCase === 'mangled') return name.replace(/[aeiouAEIOU]/, '_')
	return name
}

const events = new Map()
const ctx = {
	canvas: { addEventListener() {}, removeEventListener() {}, clientWidth: 800, clientHeight: 600 },
	// 13 movement + rain + thunder reservations leave the original eight test slots.
	config: { q: { audioVoices: 23 } },
	events: {
		on(key, fn) { events.set(key, fn); return () => events.delete(key) },
		emit(key, p) { events.get(key)?.(p); node.pendingWeapons?.drain(node.consumeWeapon) },
	},
	rng: { forkNamed: () => ({ int: () => 12345 }) },
	// `--falsify=notypetable` models the host that never published one: every weapon resolves to
	// the empty string, every shot falls back to the generic cannon, and the game plays one gun
	// sound again — which is the state this node shipped in and must never silently return to.
	actorTypeName: (id) => (falsify === 'notypetable' ? '' : actorTypeName(id)),
	get snapshot() { return snapshot },
	peek(id) { return stubs[id] ?? null },
	get: (id) => stubs[id] ?? null,
}

globalThis.AudioContext = StubContext
if (!globalThis.addEventListener) {
	globalThis.addEventListener = () => {}
	globalThis.removeEventListener = () => {}
}

// ---------------------------------------------------------------------------
// Payload writers, byte-for-byte as `SnapshotEmitter.WriteEvents` writes them.
// The first i32 of a fire record begins at byte 6 and is therefore UNALIGNED.
// ---------------------------------------------------------------------------

const FIRE_AT = 128
function writeFire(off, xM, yM, zM, caliber, weaponClass = 7, actorId = 42) {
	snapView.setUint32(off, actorId, true)
	snapView.setUint16(off + 4, 0, true)
	snapView.setInt32(off + 6, Math.round(xM * 1024), true)
	snapView.setInt32(off + 10, Math.round(zM * 1024), true)
	snapView.setInt32(off + 14, Math.round(yM * 1024), true)
	snapView.setUint16(off + 18, 300, true)
	snapView.setUint16(off + 20, weaponClass, true)
	snapView.setUint16(off + 22, caliber, true)
	return { kind: 1, offset: off, byteLength: 24 }
}

const node = new Audio()
node.init(ctx)
// First gesture: the bank is built and the context resumes. Everything below is post-wake.
events.get('__none__')
node.wake?.() ?? (globalThis.__wake = null)
// `wake` is private; the public trigger is the gesture listener, which the stub canvas
// swallowed. Call it through the instance so the gate exercises the real path.
Object.getPrototypeOf(node).wake.call(node)

if (!node.running) fail('the node did not reach a running state after the first gesture — nothing below was exercised.')

const SIM_FIRE = 'sim:weapon:fire'

/**
 * Advance the stub clock past every outstanding voice so the pool is empty again.
 *
 * Needed because the stub's `currentTime` never moves on its own, so slots stay occupied for
 * the whole run. Without it the tests are ORDER-DEPENDENT: the first version of this file read
 * a full pool after the exhaustion test and reported the malformed-payload case as "the node
 * stopped scheduling", which was the gate's own state leaking between assertions rather than
 * anything wrong with the node. An instrument that fails on its own residue is the failure
 * mode this whole tool exists to catch, so it is worth the four lines.
 */
function settle() {
	node.actx.currentTime += 30
}

/**
 * Fire one shot and SNAPSHOT its placement as plain numbers.
 *
 * Reading `gain.value` later does not work, and the reason is the pool doing its job: with the
 * clock settled between shots, consecutive sounds are handed the SAME free slot, so the second
 * shot overwrites the first's gain and pan before either is compared. The gate's first run
 * therefore reported a shot at 10 m and one at 300 m as having identical gain, and two sources
 * on opposite sides as panning the same way — both were the instrument aliasing itself, not
 * the node. Capture at the moment of scheduling.
 */
function fire(xM, yM, zM, caliber = 300, weaponClass = 7, actorId = 42, tick = 0) {
	settle()
	started.length = 0
	snapshot.tick = tick
	ctx.events.emit(SIM_FIRE, writeFire(FIRE_AT, xM, yM, zM, caliber, weaponClass, actorId))
	return started.map(e => ({
		when: e.when,
		t0: e.t0,
		gain: e.gain?.gain?.value ?? 0,
		pan: panOfSlot(e.gain),
		rate: e.src.playbackRate.value,
		buffer: e.src.buffer,
	}))
}

/** Fire the named weapon at its own authored damage, and report which buffer it reached. */
function fireWeapon(name) {
	const row = ROSTER.weapons[name]
	const shots = fire(0, 0, 10, row.damage, weaponTypeId(name))
	return { shots, row }
}

/** The node owns the chain; find the panner belonging to the slot this source connected to. */
function panOfSlot(gainNode) {
	for (const s of node.slots ?? []) if (s.gain === gainNode) return s.pan.pan.value
	return 0
}

console.log(`${TOOL}: node up, ${node.running ? 'running' : 'NOT running'}${falsify ? `  (--falsify=${falsify})` : ''}`)

// --- 1, 2, 3  one source, delayed and attenuated by distance ---------------
{
	const near = fire(0, 0, 10)
	if (near.length !== 1) fail(`a single fire event scheduled ${near.length} sources, expected exactly 1.`)
	const far = fire(0, 0, 300)
	if (far.length !== 1) fail(`a distant fire event scheduled ${far.length} sources, expected exactly 1.`)

	if (near.length === 1 && far.length === 1) {
		const dNear = Math.hypot(0 - 0, 0 - 30, 10 - 0)
		const dFar = Math.hypot(0, -30, 300)
		const errNear = Math.abs((near[0].when - near[0].t0) - dNear / SPEED_OF_SOUND)
		const errFar = Math.abs((far[0].when - far[0].t0) - dFar / SPEED_OF_SOUND)
		console.log(`  delay: near ${(near[0].when - near[0].t0).toFixed(4)} s (expect ${(dNear / SPEED_OF_SOUND).toFixed(4)}), far ${(far[0].when - far[0].t0).toFixed(4)} s (expect ${(dFar / SPEED_OF_SOUND).toFixed(4)})`)
		if (errNear > 1e-6 || errFar > 1e-6)
			fail(`scheduled start times do not match distance / ${SPEED_OF_SOUND} m/s (near off by ${errNear.toExponential(2)}, far by ${errFar.toExponential(2)}) — the depth cue is not being applied.`)
		if (!(far[0].when - far[0].t0 > near[0].when - near[0].t0))
			fail('a shot 300 m away is not heard later than one 10 m away — sound is arriving instantly.')

		const gNear = near[0].gain
		const gFar = far[0].gain
		console.log(`  gain: near ${gNear.toFixed(4)}, far ${gFar.toFixed(4)}`)
		if (!(gNear > gFar)) fail(`a shot at 300 m (${gFar.toFixed(4)}) is not quieter than one at 10 m (${gNear.toFixed(4)}).`)
		if (!(gFar > 0)) fail('a shot at 300 m is fully silent — it is inside MAX_AUDIBLE_M and should still be heard faintly.')
	}
}

// --- 4  pan follows which side of the listener the sound is on -------------
{
	// Listener at the origin looking down -Z... the basis is whatever `camera` reports, so the
	// assertion is deliberately RELATIVE: two sources mirrored about the view axis must pan to
	// opposite signs. That holds under any handedness and catches a dropped or constant pan.
	listenerEye = new Float32Array([0, 30, 60])
	listenerFocus = new Float32Array([0, 0, 0])
	const right = fire(40, 0, 0)
	const left = fire(-40, 0, 0)
	const panR = right[0]?.pan ?? 0
	const panL = left[0]?.pan ?? 0
	console.log(`  pan: source at x=+40 -> ${panR.toFixed(4)}, x=-40 -> ${panL.toFixed(4)}`)
	if (Math.abs(panR) < 1e-6 && Math.abs(panL) < 1e-6)
		fail('two sources 80 m apart across the view both panned to dead centre — stereo placement is not being applied.')
	else if (!(panR * panL < 0))
		fail(`sources on opposite sides of the listener panned to the same side (${panR.toFixed(3)} and ${panL.toFixed(3)}).`)
	listenerEye = new Float32Array([0, 30, 0])
}

// --- 5  §4.7 fog ------------------------------------------------------------
{
	shroudVisible = false
	const hidden = fire(0, 0, 10)
	shroudVisible = true
	const seen = fire(0, 0, 10)
	console.log(`  shroud: hidden ${hidden.length} source(s), visible ${seen.length}`)
	if (hidden.length !== 0)
		fail(`a shot inside the fog scheduled ${hidden.length} source(s) — §4.7 says it is not drawn, and it must not be heard either. An audible enemy you cannot see has no counterplay.`)
	if (seen.length !== 1)
		fail('a shot in visible ground did not play — the shroud filter is suppressing everything.')
}

// --- 6  pool exhaustion drops, and says so ---------------------------------
{
	settle()
	const before = node.voicesDropped
	started.length = 0
	// The pool is 8 (config above). Fire many more in one instant; every one is scheduled at
	// the same currentTime, so none can have finished.
	for (let i = 0; i < 40; i++) ctx.events.emit(SIM_FIRE, writeFire(FIRE_AT, 0, 0, 10))
	const dropped = node.voicesDropped - before
	console.log(`  pool: 40 simultaneous shots into 8 slots -> ${started.length} scheduled, ${dropped} dropped`)
	if (started.length > 8)
		fail(`${started.length} sources were scheduled into an 8-slot pool — the pool is not bounding anything.`)
	if (dropped !== 40 - started.length)
		fail(`${40 - started.length} shots did not play but only ${dropped} were counted as dropped — the diagnostic under-reports pool pressure, which is the number used to decide whether the pool is big enough.`)
}

// --- 7  a short payload is ignored rather than read past -------------------
{
	settle()
	started.length = 0
	ctx.events.emit(SIM_FIRE, { kind: 1, offset: FIRE_AT, byteLength: 8 })
	if (started.length !== 0)
		fail('an 8-byte payload was accepted for a 24-byte record — the handler is reading past the record it was given.')
	// And the node must still be alive afterwards.
	started.length = 0
	node.voicesDropped
	const ok = fire(0, 0, 10)
	if (ok.length !== 1) fail('the node stopped scheduling after a malformed event — a bad record must not poison the stream.')
}

// --- 8, 9  movement weight lands on the actor's own surface ----------------
{
	const SURFACES = 13
	const typeNames=['1tnk','tran','heli','mig','ss','dd'],nameOf=ctx.actorTypeName
	ctx.actorTypeName=id=>typeNames[id-60000]??nameOf(id)
	const gainsFor = (surface, speed, type=0) => {
		snapshot.actors = {
			count: 1,
			id: new Uint32Array([1]),
			typeId:new Uint16Array([60000+type]),flags:new Uint8Array(1),owner:new Uint8Array(1),health:new Uint8Array([255]),
			posX: new Int32Array([0]),
			posY: new Int32Array([0]),
			posZ: new Int32Array([0]),
			speed: new Uint16Array([speed]),
			surface: new Uint8Array([surface]),
		}
		// Several updates so the exponential smoother reaches its target.
		for (let i = 0; i < 200; i++) node.update(0.016, ctx)
		return (node.loops ?? []).map(l => l.gain.gain.value)
	}

	const onGravel = gainsFor(3, 120)
	const loudest = onGravel.indexOf(Math.max(...onGravel))
	console.log(`  movement: one actor on gravel (surface 3) at speed 120 -> loudest loop is ${loudest}, gain ${Math.max(...onGravel).toFixed(4)}`)
	if (onGravel.length !== SURFACES)
		fail(`${onGravel.length} movement loops exist, expected one per §8 surface (13).`)
	else if (loudest !== 3)
		fail(`an actor standing on gravel drove loop ${loudest} instead of loop 3 — movement audio is not reading the actor's own surface.`)
	else {
		let others = 0
		for (let i = 0; i < onGravel.length; i++) if (i !== 3 && onGravel[i] > 1e-4) others++
		if (others > 0) fail(`${others} loops for surfaces nobody is standing on are audible — every moving actor is heard on every ground type at once.`)
	}

	const stopped = gainsFor(3, 0)
	console.log(`  movement: same actor at speed 0 -> max gain ${Math.max(...stopped).toFixed(6)}`)
	if (Math.max(...stopped) > 1e-3)
		fail(`a stationary actor still drives the engine loop at ${Math.max(...stopped).toFixed(4)} — parked vehicles idle audibly forever.`)
	for(let type=1;type<typeNames.length;type++)if(Math.max(...gainsFor(8,120,type))>1e-3)fail(typeNames[type]+' leaked into ground engine mixer')
	gainsFor(3,120);snapshot.flags|=2;node.update(0,ctx)
	if(node.loops.some(l=>l.gain.gain.value!==0))fail('paused movement mixer remained audible')
	snapshot.flags&=~2;ctx.actorTypeName=nameOf
	console.log('  motor isolation: flying/floating types excluded from ground loops; pause silences movement')
	snapshot.actors = null
}

// --- 10  A SHOT PLAYS ITS OWN WEAPON'S VOICE -------------------------------
//
// The whole point of the rebuilt bank, asserted where it can actually be got wrong. Each of
// these weapons is fired by NAME through the real string-table path, and the buffer it reaches
// is compared against the one its family and its own damage select. If the join silently fails
// — a casing mismatch, a missing table, a reordered family list — every one of them lands on
// the fallback cannon and this is the only thing in the repository that would notice.
// ---------------------------------------------------------------------------
{
	const probes = ['TeslaZap', 'Dragon', 'SCUD', 'ChainGun.Yak', 'Pistol', '120mm', '155mm', 'Flamer', 'TorpTube', 'DogJaw', 'Heal', 'ParaBomb']
	const reached = new Map()
	for (const name of probes) {
		const { shots, row } = fireWeapon(name)
		if (shots.length !== 1) { fail(`${name}: fired ${shots.length} sources, expected 1.`); continue }
		const want = node.reports[row.family]?.[reportBand(row.damage)]
		if (want === undefined) { fail(`${name}: family ${row.family} has no row in the node's report bank.`); continue }
		if (shots[0].buffer !== want)
			fail(`${name} (family ${ROSTER.families[row.family]}, damage ${row.damage}) played a buffer that is not its family's — the weapon join is not reaching the bank, so every weapon in the game is voiced as the fallback.`)
		reached.set(name, shots[0].buffer)
	}
	const distinct = new Set(reached.values()).size
	console.log(`  weapon join: ${probes.length} named weapons -> ${distinct} distinct buffers` +
		` (tesla, rocket, mg, rifle, cannon, artillery, flame, torpedo, melee, heal, bomb)`)
	// The number that would have been 1 before this work. Eleven families among twelve probes
	// (SCUD and Dragon are both rockets and legitimately share a family; they differ in band).
	if (distinct < 10)
		fail(`twelve differently-armed weapons reached only ${distinct} distinct buffers — they are sharing voices, which is the defect this node was rebuilt to remove.`)
	// And the two that must NOT be the same: a tesla coil and a tank cannon.
	if (reached.get('TeslaZap') === reached.get('120mm'))
		fail('a tesla coil and a 120mm tank cannon played the same buffer.')
	if (reached.get('Dragon') === reached.get('Pistol'))
		fail('a rocket launcher and a pistol played the same buffer.')
}

// The commando's bank override must not recolour an ordinary rifle or suppress fallback.
{
 const savedUnits = stubs.units
 const recorded = { duration: 1 }
 node.sfx.set('riki_rifle', recorded)
 stubs.units = { weaponNameOf: () => 'Colt45' }
 const riki = fireWeapon('Colt45').shots[0]
 if (riki?.buffer !== recorded) fail('Riki did not use her recorded rifle.')
 stubs.units = { weaponNameOf: () => 'M1Carbine' }
 const ordinary = fireWeapon('Colt45').shots[0]
 if (ordinary?.buffer === recorded) fail('Ordinary infantry inherited Riki rifle audio.')
 if (!riki || !ordinary || Math.abs(riki.gain / ordinary.gain - 2.3) > 1e-6)
  fail('Riki recorded rifle must get its 2.3x trim without raising ordinary weapons.')
 node.sfx.delete('riki_rifle')
 stubs.units = { weaponNameOf: () => 'Colt45' }
 const fallback = fireWeapon('Colt45').shots[0]
 if (!fallback) fail('Missing Riki clip silenced her weapon.')
 if (fallback && ordinary && fallback.gain !== ordinary.gain) fail('Missing Riki clip boosted the generic fallback.')
 stubs.units = savedUnits
 console.log('  Riki rifle: unique override, 2.3x recorded-only gain, ordinary-weapon isolation, missing-clip fallback')
}

// --- 10b  THE JOIN SURVIVES THE CASING THE HOST ACTUALLY PUBLISHES ---------
//
// `Ruleset.Weapons` is keyed by the LOWERCASED weapon name. A live match has already been seen
// publishing "dragon" against a catalogue holding "Dragon", and the failure was completely
// silent: every row matched nothing and every visual it drove vanished, with no error anywhere.
// This fires the same weapons twice, once in each casing, and demands the same buffer.
// ---------------------------------------------------------------------------
{
	const probes = ['TeslaZap', 'Dragon', 'ChainGun.Yak', 'SilencedPPK', 'FLAK-23-AG']
	// VACUITY GUARD. If every weapon in the mod were already lowercase, firing "as authored"
	// and "as lowercased" would be the same call and this whole section would assert nothing.
	if (!probes.some(n => n !== n.toLowerCase()))
		fail('none of the casing probes has a mixed-case name, so firing them lowercased exercises nothing — pick weapons whose authored name actually has capitals.')
	typeTableCase = 'authored'
	const authored = probes.map(n => fireWeapon(n).shots[0]?.buffer)
	// `--falsify=nocase` makes the node's lookup case-SENSITIVE by publishing a casing the
	// table cannot hold at all, which is exactly what the live host did.
	typeTableCase = falsify === 'nocase' ? 'mangled' : 'lower'
	const lowered = probes.map(n => fireWeapon(n).shots[0]?.buffer)
	typeTableCase = 'authored'
	let mismatched = 0
	for (let i = 0; i < probes.length; i++) if (authored[i] !== lowered[i]) mismatched++
	console.log(`  casing: ${probes.length} weapons fired as authored and as lowercased -> ${mismatched} mismatch(es)`)
	if (mismatched > 0)
		fail(`${mismatched} weapon(s) reached a different voice when the host published the lowercased name — Ruleset.Weapons lowercases its keys, so this is the casing a live match actually sends, and the mismatch is silent.`)
	// The half with the teeth: a lowercased tesla coil must still be a tesla coil, not the
	// fallback cannon. Comparing the two runs alone would pass happily if BOTH fell back.
	const teslaRow = ROSTER.weapons.TeslaZap
	typeTableCase = 'lower'
	const loweredTesla = fireWeapon('TeslaZap').shots[0]?.buffer
	typeTableCase = 'authored'
	if (loweredTesla !== node.reports[teslaRow.family]?.[reportBand(teslaRow.damage)])
		fail('a tesla coil published in the lowercased casing the host actually sends did not reach the electric bank — the join is case-sensitive, and it fails silently by voicing every weapon in the game as a cannon.')
}

// --- 11  PER-SHOT VARIATION IS A PURE FUNCTION OF THE SHOT -----------------
//
// Two rounds of the same weapon must not be bit-identical (a burst would read as one buffer
// stuttered), and the same round must vary the same way on two machines. The old
// implementation stepped an LCG once per call, which satisfies the first and fails the second
// the moment one client drops a report the other does not — and this node drops reports by
// design when its pool is full.
// ---------------------------------------------------------------------------
{
	const a = fire(0, 0, 10, 4000, weaponTypeId('120mm'), 7, 100)[0]
	const b = fire(0, 0, 10, 4000, weaponTypeId('120mm'), 7, 101)[0]
	const again = fire(0, 0, 10, 4000, weaponTypeId('120mm'), 7, 100)[0]
	// Interleave unrelated shots to advance any hidden counter, then repeat the first shot.
	for (let i = 0; i < 5; i++) fire(0, 0, 10, 900, weaponTypeId('ZSU-23'), 9, 200 + i)
	const afterOthers = fire(0, 0, 10, 4000, weaponTypeId('120mm'), 7, 100)[0]
	console.log(`  variation: tick 100 -> rate ${a.rate.toFixed(6)}, tick 101 -> ${b.rate.toFixed(6)}, ` +
		`tick 100 repeated -> ${again.rate.toFixed(6)}, and after 5 unrelated shots -> ${afterOthers.rate.toFixed(6)}`)
	if (a.rate === b.rate)
		fail('two rounds of the same weapon on consecutive ticks got the same playback rate — a burst will read as one buffer played twice.')
	if (a.rate !== again.rate)
		fail('the same shot produced a different rate on a second evaluation — the variation is not a function of the shot.')
	if (a.rate !== afterOthers.rate)
		fail('the same shot varied differently once other shots had been played in between — the variation is order-dependent, so a client that drops one report desynchronises the sound of the whole battle from its neighbour\'s.')
}

// --- 11b  DAMAGE STILL SCALES, CONTINUOUSLY --------------------------------
//
// Three buffers per family carry a smooth size axis only because `handleFire` corrects the
// playback rate from the weapon's exact damage to its band's centre. If that term is dropped
// the bank silently becomes three steps wide.
// ---------------------------------------------------------------------------
{
	// Two cannons in the SAME band, so the comparison is about the correction and nothing else.
	// `FLAK-23-AA` at 1200 and `105mm` at 4000 both land in band 1; if they did not, they would
	// be voiced at two different band centres and their rates would not be comparable at all —
	// which is how the first version of this assertion managed to fail on correct code.
	const light = fireWeapon('FLAK-23-AA').shots[0]
	const heavy = fireWeapon('105mm').shots[0]
	console.log(`  scale: 1200-damage cannon rate ${light.rate.toFixed(4)} vs 4000-damage cannon rate ${heavy.rate.toFixed(4)}` +
		`${light.buffer === heavy.buffer ? ' (same buffer — the difference is entirely the correction)' : ' (DIFFERENT buffers)'}`)
	if (light.buffer !== heavy.buffer)
		fail('FLAK-23-AA and 105mm no longer share a report band, so this assertion is comparing two band centres rather than the scale correction. Pick two weapons that do.')
	else if (!(light.rate > heavy.rate))
		fail(`a 1200-damage cannon (rate ${light.rate.toFixed(4)}) is not pitched above a 4000-damage one (rate ${heavy.rate.toFixed(4)}) sharing its buffer — the continuous scale correction is not being applied, so damage only moves the sound in three steps.`)
	// And the correction must stay small: a resample far from unity stops sounding like the
	// same weapon. This is the ceiling the clamp in `handleFire` exists to hold.
	for (const [name] of WEAPON_NAMES.map(n => [n])) {
		const r = fireWeapon(name).shots[0]
		if (r && (r.rate < 0.75 || r.rate > 1.30))
			fail(`${name} plays at rate ${r.rate.toFixed(3)} — far enough from unity that the buffer stops sounding like the weapon it was rendered for.`)
	}
}

// Optional motors occupy the SAME eight slots; a combat report reclaims them before dropping.
{
 node.actx.currentTime+=30
 const before=node.voicesDropped, preemptions=node.engines.stats.preemptions
 for(const slot of node.slots){slot.engine=node.actx.createBufferSource();slot.engineId=7000;slot.freeAt=Infinity}
 started.length=0
 for(let i=0;i<8;i++)ctx.events.emit(SIM_FIRE,writeFire(FIRE_AT,0,0,10))
 if(started.length!==8||node.voicesDropped!==before||node.engines.stats.preemptions-preemptions!==8)fail('motor loops displaced combat reports')
 console.log('  motor priority: eight occupied motor slots -> eight combat reports, zero additional drops')
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — ${problems.length} problem(s)`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — sounds are placed, delayed, attenuated, panned, fogged, bounded and driven by the ground the actor is on.`)
