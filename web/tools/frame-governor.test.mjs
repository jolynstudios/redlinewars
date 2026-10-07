import assert from 'node:assert/strict'
import test from 'node:test'
import {
	assessFramePacing,
	assessLocked60,
	createPaceMachine,
	GOVERNOR_WINDOW_MS,
	isUsableFrameSample,
	MAX_INFERRED_DISPLAY_MS,
	MIN_GOVERNOR_SAMPLES,
	notePaceWindow,
	shouldAssessFrameWindow,
} from '../src/core/frame-governor.ts'

const highPreset = {
	scale: 1, contact: true, cascades: 4,
	wind: false, weather: true, near: false,
	scaleOnly: false, floor: 0.5,
}

test('shipped lock sheds one step from its start state and restores that step after headroom', () => {
	const machine = createPaceMachine(highPreset)
	const over = () => notePaceWindow(machine, highPreset, 16.7, 24, 24)
	assert.deepEqual(over(), [])
	const shed = over()
	assert.equal(shed.length, 1)
	assert.equal(shed[0].kind, 'scale')
	assert.ok(machine.live.scale < 1)
	const shedScale = machine.live.scale
	const held = () => notePaceWindow(machine, highPreset, 8.3, 8.3, 8.3)
	for (let i = 0; i < 14; i++) assert.deepEqual(held(), [])
	const restored = held()
	assert.equal(restored.length, 1)
	assert.equal(restored[0].kind, 'scale')
	assert.ok(machine.live.scale > shedScale)
	assert.ok(Math.abs(machine.live.scale - 1) < 1e-6)
})

test('a barely held 60 Hz cadence does not restore and oscillate after a shed', () => {
	const machine = createPaceMachine(highPreset)
	const hot = () => notePaceWindow(machine, highPreset, 16, 24, 24)
	assert.deepEqual(hot(), [])
	assert.deepEqual(hot(), [{ kind: 'scale', scale: 0.85 }])
	for (let cycle = 0; cycle < 3; cycle++) {
		for (let i = 0; i < 5; i++) assert.deepEqual(notePaceWindow(machine, highPreset, 8, 16.7, 17.5), [])
		assert.equal(machine.live.scale, 0.85)
	}
})

test('a genuinely steady 60 Hz display can restore after cooldown and five windows', () => {
	const machine = createPaceMachine(highPreset)
	for (let i = 0; i < 2; i++) notePaceWindow(machine, highPreset, 16.7, 24, 24)
	assert.equal(machine.live.scale, 0.85)
	for (let i = 0; i < 14; i++)
		assert.deepEqual(notePaceWindow(machine, highPreset, 16.7, 16.7, 16.7), [])
	assert.deepEqual(notePaceWindow(machine, highPreset, 16.7, 16.7, 16.7), [{ kind: 'scale', scale: 1 }])
})

test('a learned 120 Hz display does not mistake steady 60 fps for restore headroom', () => {
	const machine = createPaceMachine(highPreset)
	notePaceWindow(machine, highPreset, 8.3, 8.3, 8.3)
	assert.ok(machine.displayMs <= 8.3)
	for (let i = 0; i < 2; i++) notePaceWindow(machine, highPreset, 16.7, 24, 24)
	for (let i = 0; i < 25; i++)
		assert.deepEqual(notePaceWindow(machine, highPreset, 16.7, 16.7, 16.7), [])
	assert.equal(machine.live.scale, 0.85)
})

test('headroom never enables grass meshes absent from the loaded preset', () => {
	const preset = { ...highPreset }
	const machine = createPaceMachine(preset)
	const easy = () => notePaceWindow(machine, preset, 8, 8, 10)
	for (let i = 0; i < 20; i++) assert.deepEqual(easy(), [])
	assert.equal(machine.live.near, false)
	assert.equal(machine.live.wind, false)
	const hot = () => notePaceWindow(machine, preset, 16, 24, 24)
	assert.deepEqual(hot(), [])
	const down = hot()
	assert.equal(down[0].kind, 'scale')
	assert.equal(machine.live.near, false)
	assert.ok(machine.live.scale < 1)
})

test('resident grass extras can still return after a shed', () => {
	const preset = { ...highPreset, near: true, wind: true }
	const machine = createPaceMachine(preset)
	machine.live.near = false
	machine.live.wind = false
	const easy = () => notePaceWindow(machine, preset, 8, 8, 10)
	for (let i = 0; i < 4; i++) assert.deepEqual(easy(), [])
	assert.deepEqual(easy(), [{ kind: 'near', on: true }])
	for (let i = 0; i < 4; i++) assert.deepEqual(easy(), [])
	assert.deepEqual(easy(), [{ kind: 'wind', on: true }])
})

test('Dynamic preserves real 60 Hz and 30 Hz display pacing', () => {
	for (const ms of [1000 / 60, 1000 / 30]) {
		const result = assessFramePacing(ms, ms, 22)
		assert.equal(result.overBudget, false)
		assert.equal(result.displayPaced, true)
	}
})

test('Dynamic does not mistake a stable 10 fps workload for display pacing', () => {
	const result = assessFramePacing(100, 100, 22)
	assert.equal(result.ceilingMs, 50)
	assert.equal(result.overBudget, true)
	assert.equal(result.severe, true)
	assert.equal(result.displayPaced, false)
})

test('Dynamic degrades mixed slow frames and does not restore at 24 Hz', () => {
	const mixed = assessFramePacing(1000 / 60, 40, 22)
	assert.equal(mixed.overBudget, true)
	assert.equal(mixed.displayPaced, false)

	const slowDisplay = assessFramePacing(1000 / 24, 1000 / 24, 22)
	assert.equal(slowDisplay.overBudget, false)
	assert.equal(slowDisplay.displayPaced, false)
	assert.equal(MAX_INFERRED_DISPLAY_MS, 1000 / 30)
})

test('High and Dynamic treat anything slower than 60 Hz as over budget', () => {
	const held = assessLocked60(1000 / 60, 1000 / 60, 1000 / 60)
	assert.equal(held.overBudget, false)
	assert.equal(held.displayPaced, true)
	assert.equal(held.severe, false)

	const flat30 = assessLocked60(1000 / 30, 1000 / 30, 1000 / 30)
	assert.equal(flat30.overBudget, true)
	assert.equal(flat30.displayPaced, false)
	assert.equal(flat30.severe, true)

	const mixed = assessLocked60(1000 / 60, 1000 / 60, 33)
	assert.equal(mixed.overBudget, true)
	assert.equal(mixed.severe, false)
	assert.equal(mixed.displayPaced, false)
})

test('sampling is time-bounded and excludes paused or invalid frame intervals', () => {
	assert.equal(shouldAssessFrameWindow(MIN_GOVERNOR_SAMPLES, GOVERNOR_WINDOW_MS, 120), true)
	assert.equal(shouldAssessFrameWindow(120, 1000, 120), true)
	assert.equal(shouldAssessFrameWindow(MIN_GOVERNOR_SAMPLES - 1, GOVERNOR_WINDOW_MS * 2, 120), false)
	for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
		assert.equal(isUsableFrameSample(invalid), false)
	assert.equal(isUsableFrameSample(100), true)
})
