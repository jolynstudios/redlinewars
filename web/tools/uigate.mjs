#!/usr/bin/env node
// STEELSEED — tools/uigate
//
// Selection is the one system in this project whose correctness a screenshot cannot show.
// `capture.mjs` boots the game with nothing selected, so the ring is never drawn and a
// completely broken picker captures a perfectly good frame. Every other failure this project
// has shipped was found by an image; this one cannot be.
//
// So this drives the real node headlessly and asserts on WHICH ACTOR came back.
//
// The projection here is the project's own `m4`, and the gate projects a point exactly the
// way the node does. That is deliberate and it is a stated limit: this gate does NOT verify
// the projection convention — it verifies the PICKING BEHAVIOUR built on top of it (nearest
// hit, radius, the behind-camera guard, CSS-vs-device pixels, pruning, ring placement). If
// the renderer's matrix convention ever changed, `capture` would go black long before this
// gate noticed, which is the right division of labour.
//
// Usage:
//   node tools/uigate.mjs [--falsify=dpr|behind]

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'uigate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = n => {
	const hit = process.argv.find(a => a.startsWith(`--${n}=`))
	return hit ? hit.slice(n.length + 3) : null
}
const falsify = arg('falsify')
if (falsify !== null && falsify !== 'dpr' && falsify !== 'behind') {
	console.error(`${TOOL}: unknown --falsify=${falsify}`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'uigate-'))
const entry = join(tmp, 'e.ts')
writeFileSync(entry, [
	`export { Ui } from '${WEB}/src/ui/index'`,
	`export { m4, mat4, vec3 } from '${WEB}/src/core/math'`,
].join('\n') + '\n')
const bundle = join(tmp, 'b.mjs')
await esbuild({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent' })
const { Ui, m4, mat4, vec3 } = await import(bundle)

const problems = []
const note = m => problems.push(m)

// --- the world ----------------------------------------------------------------
//
// A DPR of 2 is not incidental. The pointer arrives in CSS pixels and the canvas backing
// store is device pixels; a node that mixes them is correct on a 1x display and wrong by
// exactly 2x on this one, which is the single most common way a picker ships broken.
const CSS_W = 800, CSS_H = 600, DPR = 2
const CELL = 1024
const wpos = m => Math.round(m * CELL)

/** A real slope, so the ring-placement check cannot pass against a constant. */
const heightAt = (x, z) => 0.18 * x - 0.09 * z + 1.0

const eye = vec3(0, 26, 34)
const view = m4.lookAt(mat4(), eye, vec3(0, 0, 0), vec3(0, 1, 0))
const proj = m4.perspectiveReverseZ(mat4(), 50 * Math.PI / 180, CSS_W / CSS_H, 0.1)
const viewProj = m4.multiply(mat4(), proj, view)

/** Project a world point the way the node does. `guard` false keeps points behind the eye. */
function project(x, y, z, guard = true) {
	const vp = viewProj
	const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
	if (guard && cw <= 0) return null
	const cx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw
	const cy = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw
	return [(cx * 0.5 + 0.5) * CSS_W, (0.5 - cy * 0.5) * CSS_H]
}

/** The node aims at the actor's middle, 0.6 m above the ground under it. */
const aimOf = (x, z) => [x, heightAt(x, z) + 0.6, z]
const projectActor = (x, z, guard = true) => project(...aimOf(x, z), guard)
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

// --- the behind-camera decoy ---------------------------------------------------
//
// For ANY world point p, p and (2*eye - p) have identical normalised device coordinates:
// the second is the first with its view-space vector negated, and the homogeneous divide
// cancels both signs. So a point behind the camera lands EXACTLY where its mirror in front
// would, which is why an unguarded picker selects units standing behind the player.
//
// The decoy is built by mirroring: choose its ground position, take its aim point, and the
// click goes exactly where that aim point projects when the guard is removed.
const DECOY_GROUND = [-9, -14]
const decoyAim = aimOf(DECOY_GROUND[0], DECOY_GROUND[1])
const behindAim = [2 * eye[0] - decoyAim[0], 2 * eye[1] - decoyAim[1], 2 * eye[2] - decoyAim[2]]
const click = project(...decoyAim, true)
if (click === null) {
	console.error(`${TOOL}: setup is degenerate — the decoy mirror does not project. Fix the gate, not the node.`)
	process.exit(2)
}

/**
 * The real actor: near the click but not on it, so the decoy is STRICTLY nearer.
 *
 * Searched rather than hand-placed, because a hand-picked constant here silently stops
 * meaning anything the moment the camera changes. The gate refuses to run if no position
 * lands in the window — a setup that tests nothing must not report PASS.
 */
let realGround = null, realPx = null
for (let k = 1; k <= 400 && realGround === null; k++) {
	const cand = [DECOY_GROUND[0] + k * 0.02, DECOY_GROUND[1] + k * 0.01]
	const p = projectActor(cand[0], cand[1])
	if (p === null) continue
	const d = dist(p, click)
	if (d > 6 && d < 22) { realGround = cand; realPx = p }
}
if (realGround === null) {
	console.error(`${TOOL}: setup is degenerate — no real-actor position lands 6-22 px from the click.`)
	process.exit(2)
}

// --- fixtures ------------------------------------------------------------------
const ID_REAL = 41, ID_DECOY = 77, ID_FAR = 91
const FAR_GROUND = [26, 22]

function actors(list) {
	const n = list.length
	const a = {
		count: n,
		id: Int32Array.from(list.map(e => e.id)),
		posX: Int32Array.from(list.map(e => wpos(e.g[0]))),
		posY: Int32Array.from(list.map(e => wpos(e.g[1]))),
		owner: Uint8Array.from(list.map(e => e.owner)),
		// The per-frame damage scan reads every actor's health byte; full health keeps
		// the under-attack path out of the way of the picking assertions.
		health: Uint8Array.from(list.map(e => e.health ?? 100)),
		typeId: Uint16Array.from(list.map((e, i) => e.typeId ?? i + 1)),
		facing: Uint8Array.from(list.map(() => 0)),
	}
	rosterById.clear()
	for (const e of list) rosterById.set(e.id, e)
	return a
}

// The product picks the DRAWN actor: it asks the units node for the captured transform and
// mesh bounds, then projects the visual's centre. The fixture supplies the same placement
// the units node computes — origin on the ground under the actor, terrain height applied —
// with a 1.2 m box whose middle (0.6 m up) matches this harness's own aim-point projection.
const rosterById = new Map()
const PICK_MESH = { aabbMin: [-0.5, 0, -0.5], aabbMax: [0.5, 1.2, 0.5] }

// Under --falsify=behind the decoy stands IN FRONT, at the very point the click projects
// from. A working guard cannot save the node from an actor that is genuinely there, so the
// "the decoy was not selected" assertion must go red — proving that assertion observes
// something rather than passing because nothing is ever selected.
const decoyGround = falsify === 'behind'
	? DECOY_GROUND
	: [behindAim[0], behindAim[2]]

const ROSTER = [
	{ id: ID_REAL, g: realGround, owner: 3 },
	{ id: ID_DECOY, g: decoyGround, owner: 5 },
	{ id: ID_FAR, g: FAR_GROUND, owner: 1 },
]

function makeCtx() {
	const submitted = []
	const pointer = { x: 0, y: 0, dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0, inside: true }
	// readUiPalette reads computed custom properties off the canvas; Node has neither.
	if (typeof globalThis.getComputedStyle !== 'function') {
		globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
	}
	if (typeof document === 'undefined') {
		globalThis.document = { createElementNS: () => ({ style: {}, setAttribute() {}, append() {} }), querySelectorAll: () => [], querySelector: () => null, getElementById: () => null }
	}
	if (typeof globalThis.window === 'undefined') {
		globalThis.window = { addEventListener() {}, removeEventListener() {}, close() {} }
	}
	// The multiplayer switch reads the page query once net-config settles, after the checks.
	if (typeof globalThis.location === 'undefined') {
		globalThis.location = { search: '', hash: '', pathname: '/', hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/' }
	}
	if (typeof globalThis.addEventListener !== 'function') {
		globalThis.addEventListener = () => {}
		globalThis.removeEventListener = () => {}
	}
	const ctx = {
		canvas: { clientWidth: CSS_W, clientHeight: CSS_H, width: CSS_W * DPR, height: CSS_H * DPR, dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: CSS_W, height: CSS_H }), addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, parentElement: null },
		input: { pointer },
		// Selection does not consume lifecycle events, but the production Ui registers the
		// handler during init. Keep this harness faithful to Ctx without inventing an event.
		events: { on: () => () => {} },
		snapshot: null,
		get: id => {
			if (id === 'render') return {
				upload: mesh => ({ indexCount: mesh.indexCount ?? 1, vertexCount: mesh.vertexCount }),
				// The node reuses one scratch instance array, so the item must be copied here or
				// every recorded frame would show the last frame's transforms.
				submit: item => submitted.push({
					instanceCount: item.instanceCount,
					instances: item.instances.slice(0, item.instanceCount * 16),
					castsShadow: item.castsShadow,
					surfaceSet: item.surfaceSet,
					mesh: item.mesh,
					playerColors: item.playerColors ? item.playerColors.slice(0, item.instanceCount) : null,
				}),
				camera: { viewProj },
			}
			if (id === 'terrain') return { heightAt }
			if (id === 'camera') return { edgeScrollMask: 0, yaw: 0, focus: [0, 0, 0], selectActors() {}, pickGroundPoint: () => null, pickGroundCell: () => null }
			if (id === 'units') return {
				hasRaTrait: (name, trait) => trait === 'Selectable' || trait === 'Targetable' || trait === 'Health',
				selectionRadiusM: () => 3,
				captureActorVisual: (actorId, transform, lod, visual) => {
					const e = rosterById.get(actorId)
					if (!e) return false
					// This harness works in metres (see project/aimOf), so the captured
					// transform places the actor on its ground point un-scaled.
					const x = e.g[0], z = e.g[1], y = heightAt(e.g[0], e.g[1])
					transform.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])
					visual.mesh = PICK_MESH
					visual.surfaceSet = 'snow'
					visual.playerColor = 0
					return true
				},
			}
			return null
		},
		actorTypeName: () => '',
		session: { available: false },
	}
	return { ctx, pointer, submitted }
}

/** One frame: optionally click at a CSS-pixel point, then update.
 * The product decides a pick on the RELEASE edge (press opens the drag window), so a
 * click is fed as two updates: the press edge, then the release edge one frame later —
 * the same shape the Input node synthesizes for a real mouse click. */
function frame(node, ctx, pointer, at) {
	if (at !== null) {
		// --falsify=dpr feeds the DEVICE-pixel coordinate, which is what a node that read
		// `canvas.width` would need to be given to land on the same actor. A node reading
		// `clientWidth` must then miss, and the selection assertions must go red.
		pointer.x = at[0] * (falsify === 'dpr' ? DPR : 1)
		pointer.y = at[1] * (falsify === 'dpr' ? DPR : 1)
		pointer.buttons = 1
		pointer.pressed = 1
		pointer.released = 0
	} else {
		pointer.buttons = 0
		pointer.pressed = 0
		pointer.released = 0
	}
	node.update(1 / 60, ctx)
	if (at !== null) {
		pointer.buttons = 0
		pointer.pressed = 0
		pointer.released = 1
		node.update(1 / 60, ctx)
	}
	pointer.pressed = 0
	pointer.released = 0
}

function boot(list = ROSTER) {
	const { ctx, pointer, submitted } = makeCtx()
	const node = new Ui()
	node.init(ctx)
	ctx.snapshot = { actors: actors(list), shroud: null, terrainStatic: null, players: [], production: [], flags: 0, tick: 0 }
	return { node, ctx, pointer, submitted }
}

// --- 1. the ring exists before frame 1 ------------------------------------------
{
	const { node, submitted, ctx, pointer } = boot()
	if (node.selection.length !== 0) note('a freshly booted node already had a selection')
	frame(node, ctx, pointer, null)
	if (submitted.length !== 0) note('the node submitted a draw with nothing selected — an empty selection must cost zero draws')
}

// --- 2. a click on an actor selects exactly that actor ---------------------------
{
	const { node, ctx, pointer } = boot()
	frame(node, ctx, pointer, realPx)
	if (node.selection.length !== 1 || node.selection[0] !== ID_REAL)
		note(`a click on the real actor selected [${node.selection}], expected [${ID_REAL}]`)
}

// --- 3. the behind-camera guard --------------------------------------------------
//
// The click lands EXACTLY on where the decoy would project if the divide by a negative w
// were allowed — 0 px away, against the real actor's 6-22 px. An unguarded picker must
// choose the decoy. It is standing behind the player's head.
{
	const { node, ctx, pointer } = boot()
	frame(node, ctx, pointer, click)
	if (node.selection.includes(ID_DECOY))
		note(falsify === 'behind'
			// Under the falsifier the decoy genuinely stands in front, so the guard is not the
			// thing at fault. Saying so matters: a gate whose failure message names the wrong
			// cause sends the next reader to fix code that was never broken.
			? 'the decoy was selected — expected, because --falsify=behind puts it in front of the camera. This is the witness that the guard check observes something.'
			: 'an actor BEHIND the camera was selected — the w <= 0 guard is missing, so units behind the player are pickable')
	if (node.selection.length !== 1 || node.selection[0] !== ID_REAL)
		note(`the click should have fallen through to the real actor; got [${node.selection}]`)
}

// --- 4. nothing within the radius clears the selection ---------------------------
{
	const { node, ctx, pointer } = boot()
	frame(node, ctx, pointer, realPx)
	frame(node, ctx, pointer, [CSS_W - 4, CSS_H - 4])
	if (node.selection.length !== 0)
		note(`a click on empty ground left [${node.selection}] selected — clicking away must deselect`)
}

// --- 5. `pressed` is an EDGE, not a level ----------------------------------------
{
	const { node, ctx, pointer } = boot()
	frame(node, ctx, pointer, realPx)
	// Button still held, but no new press. Dragging across the field must not re-pick every
	// frame — that makes a drag flicker through every unit under the cursor.
	pointer.x = CSS_W - 4
	pointer.y = CSS_H - 4
	pointer.buttons = 1
	pointer.pressed = 0
	node.update(1 / 60, ctx)
	if (node.selection.length !== 1 || node.selection[0] !== ID_REAL)
		note('holding the button re-ran the pick — `pressed` is being read as a level, not an edge')
}

// --- 6. a click outside the canvas does not pick ----------------------------------
{
	const { node, ctx, pointer } = boot()
	pointer.inside = false
	frame(node, ctx, pointer, realPx)
	if (node.selection.length !== 0)
		note('a press with the pointer outside the canvas still picked')
}

// --- 7. a dead actor is dropped ---------------------------------------------------
{
	const { node, ctx, pointer, submitted } = boot()
	frame(node, ctx, pointer, realPx)
	const after = { actors: actors(ROSTER.filter(e => e.id !== ID_REAL)), shroud: null, terrainStatic: null, players: [], production: [], flags: 0, tick: 1 }
	node.onSnapshot(after, ctx.snapshot, ctx)
	ctx.snapshot = after
	if (node.selection.length !== 0)
		note(`the selection still holds ${node.selection} after that actor left the world — a ring would draw on empty ground, and the id can be recycled`)
	const before = submitted.length
	frame(node, ctx, pointer, null)
	if (submitted.length !== before)
		note('a draw was submitted for a dead actor')
}

// --- 8. the ring lands ON the ground under the actor -------------------------------
{
	const { node, ctx, pointer, submitted } = boot()
	frame(node, ctx, pointer, realPx)
	const it = submitted[submitted.length - 1]
	if (it === undefined) {
		note('selecting an actor submitted no draw at all')
	} else {
		if (it.instanceCount !== 1) note(`instanceCount ${it.instanceCount}, expected 1`)
		if (it.castsShadow !== false) note('the selection ring casts a shadow — a UI mark must not appear in the shadow map')
		const m = it.instances
		const want = [realGround[0], heightAt(realGround[0], realGround[1]) + 0.03, realGround[1]]
		const got = [m[12], m[13], m[14]]
		for (let i = 0; i < 3; i++) {
			if (Math.abs(got[i] - want[i]) > 1e-3)
				note(`the ring sits at ${got.map(v => v.toFixed(3))}, expected ${want.map(v => v.toFixed(3))} — it must sit on the ground under the actor`)
		}
		// A ring floating a metre up, or sunk into the terrain, is the same class of bug
		// `groundgate` exists for. 3 cm proud, no more.
		const lift = m[13] - heightAt(realGround[0], realGround[1])
		if (lift <= 0 || lift > 0.05)
			note(`the ring is ${(lift * 1000).toFixed(1)} mm off the ground — it must be proud enough not to z-fight and low enough to read as painted on`)
	}
}

const label = falsify !== null ? ` (--falsify=${falsify})` : ''
console.log(`${TOOL}: click at ${click.map(v => v.toFixed(1))} px, real actor ${dist(realPx, click).toFixed(1)} px away, decoy 0.0 px behind the camera, 8 checks${label}`)
if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — selection does not behave.`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — picks the nearest actor in CSS pixels, never one behind the camera, deselects, prunes the dead, and rings sit on the ground.`)
