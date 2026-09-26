// The menu song starts with the loading bar: it plays straight away where the browser allows,
// otherwise a "Sound on" chip appears and the first click or key anywhere starts it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = new URL('..', import.meta.url).pathname
const listeners = new Map()
globalThis.document = {
	addEventListener: (type, fn) => listeners.set(type, fn),
	removeEventListener: type => listeners.delete(type),
}
const { startBootSoundtrack } = await import('../src/boot-sound.ts')
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function fakeMusic({ enabled = true, allowAfter = 0 } = {}) {
	let calls = 0
	return {
		calls: () => calls,
		isEnabled: () => enabled,
		unlock: async () => ++calls > allowAfter,
	}
}

test('autoplay allowed: it plays at once and no chip shows', async () => {
	listeners.clear()
	const chip = { hidden: true }
	const music = fakeMusic({ allowAfter: 0 })
	startBootSoundtrack(music, chip)
	await settle()
	assert.equal(chip.hidden, true)
	assert.equal(listeners.size, 0)
})

test('autoplay refused: the chip shows, the first gesture starts the song and hides it', async () => {
	listeners.clear()
	const chip = { hidden: true }
	const music = fakeMusic({ allowAfter: 1 })
	startBootSoundtrack(music, chip)
	await settle()
	assert.equal(chip.hidden, false, 'Sound on is offered')
	assert.ok(listeners.has('pointerdown') && listeners.has('keydown'))
	listeners.get('pointerdown')()
	await settle()
	assert.equal(chip.hidden, true)
	assert.equal(listeners.size, 0, 'no listeners left behind')
})

test('muted on purpose: the loader stays silent', async () => {
	listeners.clear()
	const chip = { hidden: true }
	const music = fakeMusic({ enabled: false })
	startBootSoundtrack(music, chip)
	await settle()
	assert.equal(music.calls(), 0)
	assert.equal(chip.hidden, true)
})

test('the browser page starts it from main.ts; the desktop shell does not', () => {
	const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
	assert.match(main, /if \(typeof \(globalThis as \{ redline\?: unknown \}\)\.redline !== 'object'\)\n\tstartBootSoundtrack\(sharedMusic\(\), document\.getElementById\('boot-sound'\)\)/)
	assert.match(readFileSync(join(root, 'src/audio/index.ts'), 'utf8'), /readonly music = sharedMusic\(\)/)
	assert.match(readFileSync(join(root, 'index.html'), 'utf8'), /<button type="button" class="boot-sound" id="boot-sound" hidden>/)
})
