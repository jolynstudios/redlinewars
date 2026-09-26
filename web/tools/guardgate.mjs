#!/usr/bin/env node
// Guard is an armed command (vfx.md Epic 2). Exercises the production UI code: G arms the next
// click the way F arms attack-move, and nothing is ordered at the moment the key goes down.
//   - A left release on a Guardable actor sends Guard (follow and protect) and keeps the
//     selection; the click never reselects.
//   - A left release on ground sets Defend and walks there.
//   - A right press cancels without an order, and other command keys are ignored while armed.
//   - Shift+G only cycles the stance.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const temp = mkdtempSync(join(tmpdir(), 'steelseed-guard-'))
try {
	const outfile = join(temp, 'ui.mjs')
	await build({ stdin: { contents: "export { Ui } from './src/ui/index.ts'", resolveDir: resolve(import.meta.dirname, '..'), loader: 'ts' },
		loader: { '.m4a': 'text' }, bundle: true, platform: 'node', format: 'esm', outfile,
		define: { 'import.meta.glob': '__gateGlob' }, banner: { js: 'const __gateGlob = () => ({})' }, logLevel: 'silent' })
	const { Ui } = await import(pathToFileURL(outfile))
	globalThis.localStorage = { getItem: () => null, setItem: () => {} }
	const ui = new Ui(), vp = new Float32Array(16); vp[0] = vp[5] = vp[10] = .1; vp[15] = 1
	const names = ['1tnk', '2tnk', 't01']
	const traits = { '1tnk': ['Selectable', 'Armament', 'Guard', 'AutoTarget', 'Mobile'], '2tnk': ['Selectable', 'Guardable', 'Mobile'], t01: [] }
	// The selected light tank, a friendly medium tank to guard (drawn at 500,475), a tree.
	const actors = { count: 3, id: Uint32Array.of(10, 20, 30), typeId: Uint16Array.of(0, 1, 2), owner: Uint8Array.of(0, 0, 255),
		posX: Int32Array.of(-6144, 0, 6144), posY: new Int32Array(3), posZ: new Int32Array(3), health: Uint8Array.of(255, 255, 255) }
	const units = { hasRaTrait: (n, t) => traits[n]?.includes(t) ?? false, selectionRadiusM: () => .5, selectionHeightM: () => 1,
		movementClass: () => 'vehicle', groupSelectable: () => true,
		captureActorVisual(id, m, _offset, out) {
			const i = [10, 20, 30].indexOf(id); m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; m[12] = actors.posX[i] / 1024
			out.mesh = { aabbMin: [-.5, 0, -.5], aabbMax: [.5, 1, .5] }; return true
		} }
	const pointer = { x: 500, y: 475, pressed: 0, released: 0, buttons: 0, inside: true }
	const camera = { pickGroundCell: () => ({ x: 5, y: 7 }), pickGroundPoint: () => ({ x: 5.5, y: 0, z: 7.5 }), selectActors: () => {} }
	const orders = []
	const ctx = { canvas: { clientWidth: 1000, clientHeight: 1000 }, input: { pointer, ctrl: false, shift: false, alt: false, wasPressed: () => false },
		snapshot: { tick: 1, actors }, actorTypeName: i => names[i], get: id => id === 'units' ? units : camera,
		queryContextOrder: () => ({ order: 'Move', cursor: 'move' }),
		issueOrder: o => { orders.push({ ...o, subjectIds: [...o.subjectIds.slice(0, o.subjectCount)] }); return Promise.resolve('ok: gate') } }
	Object.assign(ui, { ctx, renderPlayerId: 0, render: { camera: { viewProj: vp } }, terrain: { heightAt: () => 0 }, selected: [10] })
	ui.eva = { say: () => {}, sayUnit: () => {}, personaOf: () => undefined, reset: () => {}, stop: () => {} }
	ui.showNotice = () => {}; ui.refreshSelectionArmed = () => {}; ui.markOrder = () => {}; ui.selectionCanReach = () => true
	const click = (x, y) => {
		Object.assign(pointer, { x, y, pressed: 1, released: 0, buttons: 1 }); ui.updateSelectionInteraction(ctx, actors, units, false)
		Object.assign(pointer, { pressed: 0, released: 1, buttons: 0 }); ui.updateSelectionInteraction(ctx, actors, units, false)
		pointer.released = 0
	}

	// G arms; nothing is ordered at the moment the key goes down.
	assert.equal(ui.handleCommandKey('g'), true)
	assert.equal(ui.guardArmed, true, 'G arms the next click')
	assert.equal(orders.length, 0, 'G alone must not order anything at the pointer')
	assert.equal(ui.handleCommandKey('v'), false, 'other command keys wait while Guard is armed')
	assert.equal(orders.length, 0)

	// A click on the Guardable tank: Guard it, keep the selection.
	click(500, 475)
	assert.deepEqual(orders.map(o => [o.orderString, o.targetActorId]), [['Guard', 20]], 'the armed click guards the actor under it')
	assert.deepEqual(ui.selected, [10], 'the guard click does not reselect')
	assert.equal(ui.guardArmed, false, 'the click consumes the arming')

	// A click on ground: Defend stance, then walk there.
	orders.length = 0
	ui.handleCommandKey('g'); click(350, 900)
	assert.deepEqual(orders.map(o => [o.orderString, o.extraData ?? 0, o.targetCell?.x, o.targetCell?.y]),
		[['SetUnitStance', 2, undefined, undefined], ['Move', 0, 5, 7]], 'ground guard settles into Defend and walks to the cell')
	assert.deepEqual(ui.selected, [10])

	// A right press cancels without issuing (the production gesture-dispatch block).
	const source = readFileSync(resolve(import.meta.dirname, '../src/ui/index.ts'), 'utf8')
	const gestureStart = source.indexOf('\t\tconst pointer = ctx.input.pointer\n\t\tconst commandModeWasArmed')
	const gestureEnd = source.indexOf('\n\t\t// --- rings', gestureStart)
	assert.ok(gestureStart >= 0 && gestureEnd > gestureStart, 'gesture dispatch block not found')
	const dispatch = new Function('ctx', 'actors', 'units', 'placedThisFrame', 'MODIFIERS_NO_PRESS', source.slice(gestureStart, gestureEnd))
	orders.length = 0
	ui.handleCommandKey('g')
	Object.assign(pointer, { x: 500, y: 475, pressed: 4, released: 0, buttons: 0 })
	dispatch.call(ui, ctx, actors, units, false, -1)
	pointer.pressed = 0
	assert.equal(ui.guardArmed, false, 'right-click cancels the armed guard')
	assert.equal(orders.length, 0, 'the cancelling right-click orders nothing')

	// Shift+G cycles the stance and does nothing else.
	ctx.input.shift = true
	assert.equal(ui.handleCommandKey('G'), true)
	ctx.input.shift = false
	assert.deepEqual(orders.map(o => [o.orderString, o.extraData ?? 0]), [['SetUnitStance', 3]], 'Shift+G cycles the stance only')
	assert.equal(ui.guardArmed, false)
	console.log('guardgate: PASS — G arms the next click; Guard on a Guardable actor keeps the selection; ground guard is Defend + Move; right-click cancels; Shift+G only cycles the stance')
} finally { rmSync(temp, { recursive: true, force: true }) }
