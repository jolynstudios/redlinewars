#!/usr/bin/env node
// A fast tablet tap can finish before the next animation frame. Its release
// still has to reach the UI as an on-canvas click, then lose hover state.
import assert from 'node:assert/strict'
import { Input } from '../src/core/input.ts'

globalThis.window = new EventTarget()

class Canvas extends EventTarget {
	captured = new Set()
	getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 200 } }
	setPointerCapture(id) { this.captured.add(id) }
	hasPointerCapture(id) { return this.captured.has(id) }
	releasePointerCapture(id) { this.captured.delete(id) }
}

function emit(canvas, type, x, y, id = 1, pointerType = 'touch') {
	const event = new Event(type)
	Object.assign(event, { clientX: x, clientY: y, pointerId: id, pointerType, button: 0 })
	canvas.dispatchEvent(event)
}

function rig() {
	const canvas = new Canvas()
	const input = new Input()
	input.attach(canvas)
	return { canvas, input }
}

{
	const { canvas, input } = rig()
	emit(canvas, 'pointerdown', 150, 100)
	emit(canvas, 'pointerup', 150, 100)
	emit(canvas, 'pointerleave', 150, 100)
	input.beginFrame()
	assert.equal(input.pointer.pressed & 1, 1, 'fast tap press survives')
	assert.equal(input.pointer.released & 1, 1, 'fast tap release survives')
	assert.equal(input.pointer.inside, true, 'the release is on canvas when UI receives it')
	input.endFrame()
	assert.equal(input.pointer.inside, false, 'touch hover ends after the click frame')
	input.dispose()
}

{
	const { canvas, input } = rig()
	emit(canvas, 'pointerdown', 140, 100)
	input.beginFrame()
	assert.equal(input.pointer.inside, true, 'a held touch remains on canvas')
	assert.equal(input.pointer.buttons & 1, 1)
	input.endFrame()
	assert.equal(input.pointer.inside, true, 'endFrame does not end a held touch')
	emit(canvas, 'pointermove', 180, 100)
	input.beginFrame()
	assert.equal(input.pointer.x, 180, 'drag still tracks the finger')
	input.endFrame()
	emit(canvas, 'pointerup', 180, 100)
	emit(canvas, 'pointerleave', 180, 100)
	input.beginFrame()
	assert.equal(input.pointer.released & 1, 1)
	assert.equal(input.pointer.inside, true)
	input.endFrame()
	assert.equal(input.pointer.inside, false)
	input.dispose()
}

{
	const { canvas, input } = rig()
	emit(canvas, 'pointerdown', 100, 100, 1)
	emit(canvas, 'pointerdown', 200, 100, 2)
	input.beginFrame()
	assert.equal(input.pointer.pressed, 0, 'two fingers cannot begin a selection')
	input.endFrame()
	emit(canvas, 'pointermove', 90, 100, 1)
	emit(canvas, 'pointermove', 210, 100, 2)
	input.beginFrame()
	assert.ok(input.pointer.pinch > 0, 'pinch still zooms')
	assert.equal(input.pointer.pressed, 0)
	input.endFrame()
	emit(canvas, 'pointerup', 90, 100, 1)
	emit(canvas, 'pointerup', 210, 100, 2)
	emit(canvas, 'pointerleave', 210, 100, 2)
	input.beginFrame()
	assert.equal(input.pointer.pressed, 0, 'pinch release cannot start a selection')
	input.endFrame()
	assert.equal(input.pointer.inside, false)
	input.dispose()
}

{
	const { canvas, input } = rig()
	emit(canvas, 'pointerdown', 0, 100)
	emit(canvas, 'pointerup', 0, 100)
	emit(canvas, 'pointerleave', 0, 100)
	input.beginFrame()
	assert.equal(input.pointer.edgeReady, false, 'touch near an edge never arms edge-scroll')
	input.endFrame()
	input.dispose()
}

{
	const { canvas, input } = rig()
	emit(canvas, 'pointerdown', 150, 100)
	emit(canvas, 'pointercancel', 150, 100)
	assert.equal(input.pointer.inside, false, 'cancel clears hover immediately')
	assert.equal(input.pointer.edgeReady, false)
	input.dispose()
}


// Alt (Option) + left-drag orbits like the middle button — a trackpad has no wheel to press —
// and the orbit ends with the left button even when Alt is released first.
{
	const { canvas, input } = rig()
	const mouse = (type, x, y, extra) => {
		const event = new Event(type)
		Object.assign(event, { clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', button: 0, altKey: false, ...extra })
		canvas.dispatchEvent(event)
	}
	mouse('pointerdown', 100, 100, { altKey: true })
	input.beginFrame()
	assert.equal(input.pointer.buttons & 2, 2, 'Alt + left press reads as the orbit button')
	assert.equal(input.pointer.buttons & 1, 0, 'and never as a selection press')
	input.endFrame()
	mouse('pointerup', 120, 100, { altKey: false })
	input.beginFrame()
	assert.equal(input.pointer.buttons & 2, 0, 'releasing the left button ends the orbit')
	assert.equal(input.pointer.released & 2, 2)
	input.endFrame()
	mouse('pointerdown', 100, 100)
	input.beginFrame()
	assert.equal(input.pointer.buttons & 1, 1, 'a plain left press still selects')
	input.endFrame()
	mouse('pointerup', 100, 100)
	input.dispose()
}

console.log('inputtouch.test PASS — fast tap, held touch, pinch, edge, cancel and Alt-orbit')
