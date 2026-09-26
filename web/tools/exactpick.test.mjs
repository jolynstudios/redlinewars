// The exact pick (owner report, 2026-09-26: "with a group selected I cannot attack that building;
// the troops go to the other side, as if I clicked a nearby building"). The production UI, fed a
// real perspective camera over a large building with a small neighbour and a soldier in front:
//   - the pointer over the large building's roof, next to the neighbour, targets the large one
//     (the nearest projected centre missed it there, and the click became a move behind it);
//   - the order's cell is where the pointer meets the building, on its footprint, not the ground
//     the ray reaches behind it (a unit with no order of its own on the building walked there);
//   - a soldier in front of the building, under the pointer, is the target;
//   - a building remembered under fog is met the same way;
//   - bare ground is still the ground, and without the eye the pick is the nearness rule.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = mkdtempSync(join(tmpdir(), 'steelseed-exact-pick-'))
const outfile = join(temp, 'ui.mjs')
await build({ stdin: { contents: "export { Ui } from './src/ui/index.ts'; export { m4 } from './src/core/math.ts'", resolveDir: resolve(import.meta.dirname, '..'), loader: 'ts' },
	loader: { '.m4a': 'text' }, bundle: true, platform: 'node', format: 'esm', outfile, define: { 'import.meta.glob': '__gateGlob' },
	banner: { js: 'const __gateGlob = () => ({})' }, logLevel: 'silent' })
const { Ui, m4 } = await import(pathToFileURL(outfile))
rmSync(temp, { recursive: true, force: true })
globalThis.localStorage = { getItem: () => null, setItem: () => {} }

const W = 1600, H = 900
const eye = new Float32Array([12, 22, 27])
const view = m4.lookAt(new Float32Array(16), eye, new Float32Array([12, 0, 10]), new Float32Array([0, 1, 0]))
const proj = m4.perspectiveReverseZ(new Float32Array(16), 48 * Math.PI / 180, W / H, 0.35)
const vp = m4.multiply(new Float32Array(16), proj, view)
const project = (x, y, z) => {
	const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
	return { x: ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w * 0.5 + 0.5) * W, y: (0.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w * 0.5) * H }
}
// The ground under a pixel: the camera's own pick, on flat ground.
const inverse = m4.invert(new Float32Array(16), vp)
const ground = (px, py) => {
	const nx = px / W * 2 - 1, ny = 1 - py / H * 2, m = inverse
	const w = m[3] * nx + m[7] * ny + m[11] + m[15]
	const p = [0, 1, 2].map(k => (m[k] * nx + m[4 + k] * ny + m[8 + k] + m[12 + k]) / w)
	const d = p.map((v, k) => v - eye[k]), t = -eye[1] / d[1]
	return { x: eye[0] + d[0] * t, y: 0, z: eye[2] + d[2] * t }
}

// Enemy war factory (3x3, cells 9-11), its power plant neighbour (2x2, cells 12-13 x 9-10), an
// enemy rifleman in front of the factory, and our tank far off (the selection).
const BOXES = {
	10: { type: 'weap', x: 10.5, z: 10.5, min: [-1.45, 0, -1.45], max: [1.45, 2.6, 1.45], radius: 2.05 },
	20: { type: 'powr', x: 13.0, z: 10.0, min: [-0.95, 0, -0.95], max: [0.95, 1.6, 0.95], radius: 1.34 },
	30: { type: 'e1', x: 10.5, z: 12.7, min: [-0.25, 0, -0.25], max: [0.25, 1.0, 0.25], radius: 0.55 },
	40: { type: '2tnk', x: 4.5, z: 20.5, min: [-0.9, 0, -0.6], max: [0.9, 1.1, 0.6], radius: 1.1 },
}
const names = ['weap', 'powr', 'e1', '2tnk']
const liveActors = ids => {
	const list = ids.map(id => ({ id, ...BOXES[id] }))
	return { count: list.length, id: Uint32Array.from(list.map(a => a.id)), typeId: Uint16Array.from(list.map(a => names.indexOf(a.type))),
		owner: Uint8Array.from(list.map(a => a.id === 40 ? 0 : 1)), posX: Int32Array.from(list.map(a => a.x * 1024)), posY: Int32Array.from(list.map(a => a.z * 1024)),
		posZ: new Int32Array(list.length), health: new Uint8Array(list.length).fill(255), flags: new Uint16Array(list.length) }
}
const byType = type => Object.values(BOXES).find(b => b.type === names[type])
const units = {
	hasRaTrait: (name, trait) => trait !== 'Building' || name === 'weap' || name === 'powr',
	selectionRadiusM: type => byType(type).radius,
	selectionHeightM: type => byType(type).max[1],
	movementClass: () => 'tracked', groupSelectable: () => true,
	captureActorVisual(id, m, _offset, out) {
		const b = BOXES[id]
		if (!b) return false
		m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; m[12] = b.x; m[14] = b.z
		out.mesh = { aabbMin: b.min, aabbMax: b.max }
		return true
	},
}

function scene(actors, { withEye = true, frozen = null } = {}) {
	const pointer = { x: 0, y: 0, pressed: 0, released: 0, buttons: 0, inside: true }
	const camera = {
		pickGroundCell: (px, py) => { const g = ground(px, py); return { x: Math.floor(g.x), y: Math.floor(g.z) } },
		pickGroundPoint: (px, py) => { const g = ground(px, py); return { ...g, cellX: Math.floor(g.x), cellY: Math.floor(g.z) } },
		selectActors: () => {},
	}
	const ctx = { canvas: { clientWidth: W, clientHeight: H }, input: { pointer, ctrl: false, shift: false, alt: false },
		snapshot: { tick: 1, actors, frozenActors: frozen, world: { boundsLeft: 0, boundsTop: 0, boundsRight: 64, boundsBottom: 64 } },
		actorTypeName: i => names[i], get: id => id === 'units' ? units : camera, queryContextOrder: () => null, issueOrder: () => Promise.resolve('ok') }
	const ui = new Ui()
	Object.assign(ui, { ctx, renderPlayerId: 0, render: { camera: { viewProj: vp, position: withEye ? eye : undefined } }, terrain: { heightAt: () => 0 },
		selected: [40], shroud: { stateAt: () => 1 } })
	const at = (x, y, z) => { Object.assign(pointer, project(x, y, z)); return ui.pointerContextIntent(ctx, actors, units, 0) }
	return { ui, ctx, at }
}

test('over the large building next to its small neighbour, the large building is the target', () => {
	const actors = liveActors([10, 20, 30, 40])
	// The factory's roof at its corner towards the power plant.
	const exact = scene(actors).at(11.85, 2.6, 9.25)
	assert.equal(exact.targetActorId, 10, 'the building under the pointer')
	// The old rule (nearest projected centre, no eye) missed the factory there: the click was a
	// move to the ground the ray meets behind it.
	const nearness = scene(actors, { withEye: false }).at(11.85, 2.6, 9.25)
	assert.notEqual(nearness.targetActorId, 10, 'the nearness rule misses the roof corner (the reported bug)')
	assert.ok(nearness.targetCellY < 9, `and its cell ${nearness.targetCellX},${nearness.targetCellY} lies behind the factory`)
	assert.equal(scene(actors).at(13.2, 1.6, 10.0).targetActorId, 20, 'the power plant under the pointer is still the power plant')
})

test("the order's cell is on the building the pointer meets, not the ground behind it", () => {
	const actors = liveActors([10, 20, 30, 40])
	const s = scene(actors)
	const intent = s.at(10.5, 2.6, 9.4)
	assert.equal(intent.targetActorId, 10)
	const behind = ground(project(10.5, 2.6, 9.4).x, project(10.5, 2.6, 9.4).y)
	assert.ok(behind.z < 9, `the ray's ground lies behind the factory (z ${behind.z.toFixed(2)})`)
	assert.ok(intent.targetCellX >= 9 && intent.targetCellX <= 11 && intent.targetCellY >= 9 && intent.targetCellY <= 11,
		`the order's cell ${intent.targetCellX},${intent.targetCellY} is on the factory's footprint`)
	assert.ok(s.ui.intentAim && Math.abs(s.ui.intentAim.x - 10.5) < 1.5, 'the order marker aims at the factory')
})

test('a soldier in front of the building, under the pointer, is the target', () => {
	const actors = liveActors([10, 20, 30, 40])
	assert.equal(scene(actors).at(10.5, 0.6, 12.7).targetActorId, 30)
})

test('a building remembered under fog is met the same way', () => {
	const frozen = { count: 1, id: Uint32Array.of(10), typeId: Uint16Array.of(0), posX: Int32Array.of(10.5 * 1024), posY: Int32Array.of(10.5 * 1024) }
	const intent = scene(liveActors([20, 40]), { frozen }).at(11.85, 2.6, 9.25)
	assert.equal(intent.targetActorId, 10)
	assert.equal(intent.targetFrozen, true)
	assert.ok(intent.targetCellY >= 9 && intent.targetCellY <= 11, `cell ${intent.targetCellX},${intent.targetCellY} on the footprint`)
})

test('bare ground is the ground under the pointer', () => {
	const actors = liveActors([10, 20, 30, 40])
	const intent = scene(actors).at(20.5, 0, 17.5)
	assert.equal(intent.targetActorId, 0)
	assert.deepEqual([intent.targetCellX, intent.targetCellY], [20, 17])
})
