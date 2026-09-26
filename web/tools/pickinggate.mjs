#!/usr/bin/env node
// The selection code must follow visible 3D placement, not an actor's ground projection.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const temp = mkdtempSync(join(tmpdir(), 'steelseed-picking-'))
try {
	const outfile = join(temp, 'source.mjs')
	await build({ stdin: { contents: "export { Ui } from './src/ui/index.ts'; export { Input } from './src/core/input.ts'; export { Picker } from './src/camera/pick.ts'",
		resolveDir: resolve(import.meta.dirname, '..'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile,
		loader: { '.m4a': 'file' },
		define: { 'import.meta.glob': '__gateGlob' }, banner: { js: 'const __gateGlob = () => ({})' }, logLevel: 'silent' })
	const { Ui, Input, Picker } = await import(pathToFileURL(outfile))
	globalThis.localStorage = { getItem: () => null, setItem: () => {} }
	const ui = new Ui(), vp = new Float32Array(16)
	vp[0] = .1; vp[5] = .1; vp[10] = .1; vp[15] = 1
	ui.render = { camera: { viewProj: vp } }; ui.terrain = { heightAt: () => 0 }
	const actors = { count: 1, id: Uint32Array.of(7), typeId: Uint16Array.of(1), owner: Uint8Array.of(0),
		posX: Int32Array.of(0), posY: Int32Array.of(0), posZ: Int32Array.of(4096) }
	let visible = true, selected = []
	const aircraftName = 'heli'
	const aircraft = JSON.parse(readFileSync(resolve(import.meta.dirname, '../src/core/ra-visual-manifest.json'), 'utf8')).actors[aircraftName]
	const units = { selectionRadiusM: () => .5, selectionHeightM: () => 1.2,
		groupSelectable: name => name === aircraftName && aircraft.renderable && aircraft.role === 'unit',
		hasRaTrait: (name, trait) => name === aircraftName && aircraft.traits.some(entry => entry.Name === trait),
		movementClass: () => 1,
		captureActorVisual(id, m, offset, out) {
			if (!visible) return false
			m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; m[12] = 2; m[13] = 4
			out.mesh = { aabbMin: [-.5, 0, -.5], aabbMax: [.5, 1, .5] }; return true
		} }
	const pointer = { x: 600, y: 275, pressed: 0, released: 0, buttons: 0, inside: true }
	const camera = { pickGroundCell: () => ({ x: 0, y: 0 }), selectActors: ids => { selected = [...ids] } }
	const ctx = { canvas: { clientWidth: 1000, clientHeight: 1000 }, input: { pointer, shift: false },
		snapshot: { tick: 1, actors }, actorTypeName: typeId => typeId === 1 ? aircraftName : '',
		queryContextOrder: async () => null,
		get: id => id === 'units' ? units : camera }
	function click(x, y) {
		Object.assign(pointer, { x, y, pressed: 1, released: 0, buttons: 1 })
		ui.updateSelectionInteraction(ctx, actors, units, false)
		Object.assign(pointer, { pressed: 0, released: 1, buttons: 0 })
		ui.updateSelectionInteraction(ctx, actors, units, false)
	}
	click(600, 275); assert.deepEqual(selected, [7], 'click rendered aircraft at interpolated X and true flight altitude')
	click(500, 475); assert.deepEqual(selected, [], 'old snapshot/ground projection is not a clickable phantom')
	// A capture miss (bucket rebuild, capacity squeeze) falls back to the snapshot position
	// (7fd3c64, the owner's selection-ring flicker fix): ground (0,0) at 4 m plus half the
	// 1.2 m selection height projects to (500, 270). The stale visual pose is no longer clickable.
	visible = false; click(600, 275); assert.deepEqual(selected, [], 'a capture miss does not keep the last visual pose clickable')
	click(500, 270); assert.deepEqual(selected, [7], 'a capture miss keeps the actor pickable at its snapshot position')
	// Fog hides an actor by leaving it out of the shroud-filtered snapshot: nothing to pick.
	actors.count = 0; selected = []; click(500, 270); assert.deepEqual(selected, [], 'an actor absent from the snapshot cannot be selected through fog')
	actors.count = 1
	ui.pendingPlacement = { actorName: 'powr', actorType: 1, queueId: 2, variant: 0 }
	pointer.pressed = 4; ctx.input.wasPressed = () => false
	assert.equal(ui.updatePlacementPreview(ctx), true, 'placement consumes its right-click cancel')
	assert.equal(ui.pendingPlacement, null)

	globalThis.window = new EventTarget()
	const canvas = new EventTarget(), captured = new Set()
	canvas.getBoundingClientRect = () => ({ left: 100, top: 50 })
	canvas.setPointerCapture = id => captured.add(id); canvas.hasPointerCapture = id => captured.has(id)
	canvas.releasePointerCapture = id => captured.delete(id)
	const input = new Input(); input.attach(canvas)
	const down = new Event('pointerdown'); Object.assign(down, { clientX: 700, clientY: 325, button: 1, pointerId: 1, pointerType: 'mouse' })
	canvas.dispatchEvent(down); input.beginFrame()
	assert.deepEqual([input.pointer.x, input.pointer.y, input.pointer.dx, input.pointer.dy], [600, 275, 0, 0],
		'first pointerdown captures its own coordinates and starts middle orbit without a jump')
	input.dispose()

	const picker = new Picker()
	const origin = picker.origin
	const direction = picker.direction
	origin[0] = 0; origin[1] = 8; origin[2] = 20
	const dx = 0, dy = 1 - 8, dz = 0 - 20
	const len = Math.hypot(dx, dy, dz)
	direction[0] = dx / len; direction[1] = dy / len; direction[2] = dz / len
	// Ridge at z>15 is 12 m; valley in front is 1 m. Eye is 4 m inside the ridge,
	// looking at the valley — the camera pose that used to make every move click miss.
	const buried = picker.pickGround((x, z) => z > 15 ? 12 : 1)
	assert.equal(buried.hit, true, 'move click still hits the valley when the eye sits inside a foreground ridge')
	assert.ok(buried.z < 15, `valley hit must be in front of the ridge, got z=${buried.z}`)
	origin[1] = 20
	const clear = picker.pickGround(() => 0)
	assert.equal(clear.hit, true, 'a camera above flat ground still picks')
	direction[1] = 0.2
	const sky = picker.pickGround(() => 0)
	assert.equal(sky.hit, false, 'a ray aimed at the sky still misses')

	console.log('pickinggate: PASS — visible interpolated flight position selects; ground phantom does not; a capture miss picks at the snapshot position; a fogged actor does not; placement cancel consumed; first press has correct coordinates; buried-eye ground pick hits the visible valley')
} finally { rmSync(temp, { recursive: true, force: true }) }
