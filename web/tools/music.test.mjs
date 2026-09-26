// The soundtrack: "Cold Start" on the boot screen and in the menus (looping); a battle opens on
// another track, never on Cold Start; in a battle all five tracks — 1 Theme, 2 Mechanical Groove,
// 3 Still Standing, 4 Reverse Order, 5 Cold Start — in random order, every one once per round and
// never twice in a row; the menu track after the match; a track that cannot load skipped instead
// of silencing the game.
import assert from 'node:assert/strict'
import { test } from 'node:test'

class FakeAudio extends EventTarget {
	constructor(src) { super(); this.src = src; this.loop = false; this.volume = 1; this.paused = true }
	play() { this.paused = false; return Promise.resolve() }
	pause() { this.paused = true }
}
globalThis.Audio = FakeAudio
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
const { Music, sharedMusic } = await import('../src/audio/music.ts')
const ALL = ['theme.m4a', 'mechanical-groove.m4a', 'still-standing.m4a', 'reverse-order.m4a', 'cold-start.m4a']
const name = audio => audio.src.split('/').pop()
const end = audio => audio.dispatchEvent(new Event('ended'))
/** A seeded generator, so the shuffle is random but repeatable. */
const seeded = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

test('the menu track opens and loops; a battle shuffles all five tracks', () => {
	const music = new Music(seeded(7))
	music.unlock()
	const audio = music['audio']
	assert.equal(name(audio), 'cold-start.m4a')
	assert.equal(audio.loop, true, 'the menu track loops gaplessly')
	music.setInMatch(true)
	assert.equal(audio.loop, false, 'in a battle every track must end so the next one plays')
	assert.notEqual(name(audio), 'cold-start.m4a', 'the battle opens on another track at once, never on the menu track')
	assert.equal(audio.paused, false, 'and plays it')
	const played = [name(audio)]
	for (let i = 0; i < 20; i++) { end(audio); played.push(name(audio)) }
	for (let i = 1; i < played.length; i++) assert.notEqual(played[i], played[i - 1], `no repeat at ${i}: ${played.join(', ')}`)
	for (let round = 0; round < 4; round++) {
		const slice = played.slice(round * 5, 5 + round * 5)
		assert.deepEqual([...slice].sort(), [...ALL].sort(), `round ${round + 1} plays every track once: ${slice.join(', ')}`)
	}
	const orders = new Set([0, 1, 2].map(r => played.slice(r * 5, 5 + r * 5).join()))
	assert.ok(orders.size > 1, 'the rounds are shuffled, not a fixed order')
	music.setInMatch(false)
	end(audio)
	assert.equal(name(audio), 'cold-start.m4a', 'after the battle: the menu track again')
	assert.equal(audio.loop, true)
})

test('no battle opens on Cold Start, whatever the shuffle, and before playback is allowed too', async () => {
	for (let seed = 1; seed <= 40; seed++) {
		const music = new Music(seeded(seed))
		music.unlock()
		await Promise.resolve()
		music.setInMatch(true)
		assert.notEqual(name(music['audio']), 'cold-start.m4a', `seed ${seed}`)
	}
	// A match that starts before the browser allowed audio opens on its battle track once it does.
	const music = new Music(seeded(5))
	music.setInMatch(true)
	await music.unlock()
	assert.notEqual(name(music['audio']), 'cold-start.m4a')
	assert.equal(music['audio'].loop, false)
})

test('a track that cannot load is skipped: the menu falls back to the theme, the battle to the rest', () => {
	const music = new Music(seeded(3))
	music.unlock()
	const audio = music['audio']
	audio.dispatchEvent(new Event('error'))
	assert.equal(name(audio), 'theme.m4a')
	assert.equal(audio.loop, true, 'the theme stands in as the looping menu track')
	music.setInMatch(true)
	const played = []
	for (let i = 0; i < 12; i++) { end(audio); played.push(name(audio)) }
	assert.ok(!played.includes('cold-start.m4a'), `the broken track stays out of the battle: ${played.join(', ')}`)
	assert.deepEqual([...new Set(played)].sort(), ALL.filter(t => t !== 'cold-start.m4a').sort())
})

test('a refused start is retried by the next gesture; one player serves the whole page', async () => {
	let refuse = true
	class ShyAudio extends FakeAudio {
		play() {
			if (refuse) return Promise.reject(new DOMException('no gesture yet', 'NotAllowedError'))
			this.paused = false
			return Promise.resolve()
		}
	}
	globalThis.Audio = ShyAudio
	try {
		const music = new Music(seeded(3))
		assert.equal(await music.unlock(), false, 'autoplay refused on the loading screen')
		refuse = false
		assert.equal(await music.unlock(), true, 'the first click starts the song')
		assert.equal(music['audio'].paused, false)
		assert.equal(await music.unlock(), true, 'later calls are free')
	} finally {
		globalThis.Audio = FakeAudio
	}
	// The loader and the audio node share one player, so the song never restarts between them.
	assert.equal(sharedMusic(), sharedMusic())
})
