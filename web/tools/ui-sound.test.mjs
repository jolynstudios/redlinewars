#!/usr/bin/env node
// STEELSEED — interface cue gate.
//
// `audio/ui-sound.ts` renders the pre-match interface cues from numbers at the first gesture.
// This measures the REAL buffers in Node (esbuild bundles the module, as lod-cache.test.mjs
// does): reproducible to the byte, finite, inside their level limits with focus the quietest
// and launch the only loud one, silent at both edges, the lengths the redesign plan specifies,
// pitched and swept the way the plan says, nothing harsh, and within the first-gesture budget.
// The bus itself is driven against a recording stub context: throttling, variant rotation,
// on/off and volume with their persistence, storage that throws, the resume hand-off, dispose.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(WEB, 'src/audio/ui-sound.ts')
const temp = mkdtempSync(join(tmpdir(), 'steelseed-uisound-'))
const outfile = join(temp, 'ui-sound.mjs')
await build({
	stdin: {
		contents: "export { renderUiCue, UI_CUES, UI_CUE_VARIANTS, UiSound } from './src/audio/ui-sound.ts'",
		resolveDir: WEB,
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
	logLevel: 'silent',
})
const { renderUiCue, UI_CUES, UI_CUE_VARIANTS, UiSound } = await import(pathToFileURL(outfile).href)

const RATES = [44100, 48000]
/** Lengths the redesign plan specifies, seconds. Every other cue only has to be short. */
const SPECIFIED_S = { focus: 0.036, select: 0.045, open: 0.14, close: 0.11, launch: 0.75 }
const SHORT_S = 0.25
const LAUNCH_MAX_PEAK = 0.3

const variants = () => UI_CUES.flatMap((name) => Array.from({ length: UI_CUE_VARIANTS[name] }, (_, v) => [name, v]))
const peakOf = (x) => x.reduce((p, s) => Math.max(p, Math.abs(s)), 0)
/** Frequency from zero crossings over [a, b) seconds, where the tone is well above its tail. */
function crossingHz(x, sr, a, b) {
	let n = 0
	for (let i = Math.round(a * sr) + 1; i < Math.round(b * sr); i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++
	return n / 2 / (b - a)
}
/** Share of a buffer's energy above `hz`, from a zero-padded radix-2 power spectrum. */
function energyAbove(x, sr, hz) {
	let n = 1
	while (n < x.length) n <<= 1
	const re = new Float64Array(n)
	const im = new Float64Array(n)
	re.set(x)
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1
		for (; j & bit; bit >>= 1) j ^= bit
		j ^= bit
		if (i < j) [re[i], re[j]] = [re[j], re[i]]
	}
	for (let len = 2; len <= n; len <<= 1) {
		for (let k = 0; k < len / 2; k++) {
			const wr = Math.cos(-2 * Math.PI * k / len)
			const wi = Math.sin(-2 * Math.PI * k / len)
			for (let a = k; a < n; a += len) {
				const b = a + len / 2
				const vr = re[b] * wr - im[b] * wi
				const vi = re[b] * wi + im[b] * wr
				re[b] = re[a] - vr
				im[b] = im[a] - vi
				re[a] += vr
				im[a] += vi
			}
		}
	}
	let total = 0
	let high = 0
	for (let k = 0; k <= n / 2; k++) {
		const p = re[k] ** 2 + im[k] ** 2
		total += p
		if (k * sr / n >= hz) high += p
	}
	return high / total
}

test('every cue renders the same bytes twice, at both common rates', () => {
	for (const sr of RATES) for (const [name, v] of variants()) {
		const a = renderUiCue(name, sr, v)
		const b = renderUiCue(name, sr, v)
		assert.ok(Buffer.from(a.buffer).equals(Buffer.from(b.buffer)), `${name}[${v}] @ ${sr} Hz`)
	}
})

test('every sample is finite and every peak inside its limit: focus quietest, launch the only loud cue', () => {
	for (const sr of RATES) {
		const peaks = {}
		for (const [name, v] of variants()) {
			const x = renderUiCue(name, sr, v)
			assert.ok(x.length > 0 && x.every(Number.isFinite), `${name}[${v}] @ ${sr} Hz has a non-finite sample`)
			const p = peakOf(x)
			assert.ok(p > 0, `${name}[${v}] is silent`)
			peaks[name] = Math.max(peaks[name] ?? 0, p)
		}
		assert.ok(peaks.launch <= LAUNCH_MAX_PEAK, `launch peak ${peaks.launch} over ${LAUNCH_MAX_PEAK}`)
		for (const name of UI_CUES) {
			if (name !== 'launch') assert.ok(peaks[name] < peaks.launch, `${name} (${peaks[name]}) is as loud as launch`)
			if (name !== 'focus') assert.ok(peaks.focus < peaks[name], `focus (${peaks.focus}) is not quieter than ${name} (${peaks[name]})`)
		}
		// UI sound practice: the cue heard most often sits 10 to 12 dB under confirm.
		const under = 20 * Math.log10(peaks.confirm / peaks.focus)
		assert.ok(under >= 10 && under <= 13, `focus sits ${under.toFixed(1)} dB under confirm`)
	}
})

test('every cue starts and ends on silence, so neither edge clicks', () => {
	for (const sr of RATES) for (const [name, v] of variants()) {
		const x = renderUiCue(name, sr, v)
		const p = peakOf(x)
		const where = `${name}[${v}] @ ${sr} Hz`
		assert.ok(Math.abs(x[0]) <= 1e-6 && Math.abs(x[x.length - 1]) <= 1e-6, `${where} does not start and end on zero`)
		// A step at the start puts the second sample at full level. A rise, even the latch click's
		// 0.3 ms one (13 samples at 44.1 kHz), keeps it near zero.
		assert.ok(Math.abs(x[1]) <= 0.05 * p, `${where} steps up at its first sample`)
		// And the last millisecond is already down in the taper.
		assert.ok(peakOf(x.subarray(x.length - Math.round(0.001 * sr))) <= 0.01 * p, `${where} is still sounding at its end`)
	}
})

test('lengths are what the plan specifies, and every other cue is short', () => {
	for (const sr of RATES) for (const [name, v] of variants()) {
		const n = renderUiCue(name, sr, v).length
		if (name in SPECIFIED_S) assert.equal(n, Math.round(SPECIFIED_S[name] * sr), `${name}[${v}] @ ${sr} Hz`)
		else assert.ok(n <= SHORT_S * sr, `${name}[${v}] runs ${(n / sr).toFixed(3)} s`)
	}
})

test('focus rotates four distinct pitches; step climbs eight, 900 to 1500 Hz', () => {
	const sr = 48000
	const focus = [2400, 2540, 2270, 2690]
	const bufs = focus.map((_, v) => renderUiCue('focus', sr, v))
	focus.forEach((hz, v) => {
		const got = crossingHz(bufs[v], sr, 0.001, 0.016)
		assert.ok(Math.abs(got - hz) / hz < 0.03, `focus[${v}] at ${got.toFixed(0)} Hz, want ${hz}`)
		if (v > 0) assert.ok(!Buffer.from(bufs[v].buffer).equals(Buffer.from(bufs[v - 1].buffer)))
	})
	const steps = Array.from({ length: 8 }, (_, v) => crossingHz(renderUiCue('step', sr, v), sr, 0.001, 0.016))
	for (let v = 1; v < 8; v++) assert.ok(steps[v] > steps[v - 1], `step pitches ${steps.map((f) => f.toFixed(0))} do not climb`)
	assert.ok(Math.abs(steps[0] - 900) / 900 < 0.03 && Math.abs(steps[7] - 1500) / 1500 < 0.03, `step spans ${steps[0]}..${steps[7]} Hz`)
	// Out of range clamps rather than failing.
	assert.equal(renderUiCue('step', sr, 99).length, renderUiCue('step', sr, 7).length)
	assert.ok(Buffer.from(renderUiCue('step', sr, -3).buffer).equals(Buffer.from(renderUiCue('step', sr, 0).buffer)))
})

test('the sweeps and the interval go the way the plan says', () => {
	const sr = 48000
	const open = renderUiCue('open', sr)
	const close = renderUiCue('close', sr)
	const confirm = renderUiCue('confirm', sr)
	// open 280 -> 520 Hz, close 520 -> 300 Hz, confirm E5 (659) -> B5 (988). Crossing counts over
	// windows this short resolve to about ±30 Hz, hence the slack.
	const [openEarly, openLate] = [crossingHz(open, sr, 0.015, 0.04), crossingHz(open, sr, 0.1, 0.13)]
	const [closeEarly, closeLate] = [crossingHz(close, sr, 0.004, 0.024), crossingHz(close, sr, 0.07, 0.09)]
	assert.ok(openEarly < 360 && openLate > 440 && openLate - openEarly > 100, `open runs ${openEarly} -> ${openLate} Hz`)
	assert.ok(closeEarly > 420 && closeLate < 360 && closeEarly - closeLate > 100, `close runs ${closeEarly} -> ${closeLate} Hz`)
	const e5 = crossingHz(confirm, sr, 0.01, 0.06)
	const b5 = crossingHz(confirm, sr, 0.1, 0.15)
	assert.ok(Math.abs(e5 - 659.26) < 20 && Math.abs(b5 - 987.77) < 30, `confirm steps ${e5.toFixed(0)} -> ${b5.toFixed(0)} Hz`)
})

test('nothing harsh and nothing that thumps: little energy above 5 kHz, no DC', () => {
	const sr = 48000
	for (const [name, v] of variants()) {
		const x = renderUiCue(name, sr, v)
		const bright = energyAbove(x, sr, 5000)
		assert.ok(bright < 0.03, `${name}[${v}] has ${(bright * 100).toFixed(1)}% of its energy above 5 kHz`)
		const mean = x.reduce((a, s) => a + s, 0) / x.length
		assert.ok(Math.abs(mean) <= 0.01 * peakOf(x), `${name}[${v}] carries DC ${mean}`)
	}
})

test('the whole set stays inside the first-gesture budget', () => {
	// The budget is under 10 ms of rendering at the first gesture. Wall time is not a stable
	// thing to assert on a shared runner, so the deterministic proxy is the audio rendered:
	// ~1.93 s of it today, which measures about 6 ms cold and 1-2 ms warm at 48 kHz.
	const seconds = variants().reduce((s, [name, v]) => s + renderUiCue(name, 48000, v).length / 48000, 0)
	assert.ok(seconds <= 2.2, `the set renders ${seconds.toFixed(2)} s of audio`)
})

test('ui-sound.ts draws no noise from Math.random', () => {
	const src = readFileSync(SOURCE, 'utf8')
	assert.doesNotMatch(src, /Math\.random/)
	assert.doesNotMatch(src, /getRandomValues/)
})

// ---------------------------------------------------------------------------
// The bus, against a recording stub. It records, it does not simulate.
// ---------------------------------------------------------------------------

function stubContext({ state = 'running', sampleRate = 48000 } = {}) {
	const ctx = {
		state,
		sampleRate,
		currentTime: 0,
		destination: { name: 'destination' },
		gains: [],
		buffers: [],
		sources: [],
		resumes: 0,
		/** A resume that settles when the test says so. */
		pendingResume: null,
		createGain() {
			const node = {
				gain: {
					value: 1,
					cancelScheduledValues() {},
					setValueAtTime(v) { this.value = v },
					setTargetAtTime(v) { this.value = v },
				},
				to: null,
				connect(n) { this.to = n },
				disconnect() { this.to = null },
			}
			ctx.gains.push(node)
			return node
		},
		createBuffer(channels, length, rate) {
			const data = new Float32Array(length)
			const buf = { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: () => data }
			ctx.buffers.push(buf)
			return buf
		},
		createBufferSource() {
			const src = {
				buffer: null, onended: null, started: false, stopped: false, to: null,
				connect(n) { this.to = n },
				disconnect() { this.to = null },
				start() { this.started = true },
				stop() { this.stopped = true },
			}
			ctx.sources.push(src)
			return src
		},
		resume() {
			ctx.resumes++
			if (ctx.pendingResume) return ctx.pendingResume.promise
			ctx.state = 'running'
			return Promise.resolve()
		},
	}
	return ctx
}

function deferredResume(ctx) {
	let resolve
	const promise = new Promise((r) => { resolve = r })
	ctx.pendingResume = { promise, settle: () => { ctx.state = 'running'; resolve() } }
	return ctx.pendingResume
}

/** Run `fn` with `globalThis.localStorage` replaced, restoring whatever was there (after it settles). */
function withStorage(descriptor, fn) {
	const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
	const restore = () => {
		if (had) Object.defineProperty(globalThis, 'localStorage', had)
		else delete globalThis.localStorage
	}
	Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor })
	let out
	try {
		out = fn()
	} catch (err) {
		restore()
		throw err
	}
	if (out && typeof out.then === 'function') return out.finally(restore)
	restore()
	return out
}

function memoryStorage(seed = {}) {
	const map = new Map(Object.entries(seed))
	return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) }
}

const played = (ctx) => ctx.sources.filter((s) => s.started)
const samplesOf = (src) => src.buffer.getChannelData(0)
const sameSamples = (a, b) => Buffer.from(a.buffer).equals(Buffer.from(b.buffer))

test('without Web Audio, and before a gesture, the bus is inert and never throws', () => {
	withStorage({ value: undefined, writable: true }, () => {
		const none = new UiSound(() => null)
		none.unlock()
		none.cue('launch')
		none.dispose()
		assert.equal(none.isEnabled(), true)
		assert.equal(none.getVolume(), 0.8)

		const ctx = stubContext()
		const bus = new UiSound(() => ctx)
		assert.equal(ctx.gains.length + ctx.buffers.length, 0, 'constructing the bus must build nothing')
		bus.dispose()
	})
})

test('unlock builds one gain to the destination and every buffer, once', () => {
	withStorage({ value: undefined, writable: true }, () => {
		const ctx = stubContext()
		const bus = new UiSound(() => ctx)
		bus.unlock()
		bus.unlock()
		assert.equal(ctx.gains.length, 1)
		assert.equal(ctx.gains[0].to, ctx.destination)
		assert.equal(ctx.gains[0].gain.value, 0.8)
		const total = UI_CUES.reduce((n, name) => n + UI_CUE_VARIANTS[name], 0)
		assert.equal(ctx.buffers.length, total)
		bus.cue('launch')
		assert.ok(sameSamples(samplesOf(played(ctx)[0]), renderUiCue('launch', ctx.sampleRate)))
		assert.equal(played(ctx)[0].to, ctx.gains[0], 'a cue plays through the UI gain')
	})
})

test('a repeat of one cue inside 65 ms is dropped; a different cue is not', () => {
	withStorage({ value: undefined, writable: true }, () => {
		let clock = 1000
		const ctx = stubContext()
		const bus = new UiSound(() => ctx, () => clock)
		bus.cue('select')
		clock += 30
		bus.cue('select')
		bus.cue('confirm')
		assert.equal(played(ctx).length, 2)
		clock += 40
		bus.cue('select')
		assert.equal(played(ctx).length, 3)
	})
})

test('focus rotates so no two in a row match; step takes its index, clamped, or wanders mid-range', () => {
	withStorage({ value: undefined, writable: true }, () => {
		let clock = 0
		const ctx = stubContext()
		const bus = new UiSound(() => ctx, () => clock)
		for (let i = 0; i < 8; i++, clock += 100) bus.cue('focus')
		const focus = played(ctx).map(samplesOf)
		for (let i = 1; i < focus.length; i++) assert.ok(!sameSamples(focus[i], focus[i - 1]), `focus ${i} repeats ${i - 1}`)
		assert.equal(new Set(focus.slice(0, 4).map((x) => Buffer.from(x.buffer).toString('base64'))).size, 4, 'four focus cues, four pitches')

		const stepAt = (v) => renderUiCue('step', ctx.sampleRate, v)
		for (const [index, want] of [[0, 0], [5, 5], [99, 7], [-4, 0], [2.6, 3]]) {
			clock += 100
			bus.cue('step', index)
			assert.ok(sameSamples(samplesOf(played(ctx).at(-1)), stepAt(want)), `step index ${index} should play pitch ${want}`)
		}
		for (const want of [3, 4, 2, 5]) {
			clock += 100
			bus.cue('step')
			assert.ok(sameSamples(samplesOf(played(ctx).at(-1)), stepAt(want)), `unindexed step should wander to ${want}`)
		}
	})
})

test('on/off and volume reach the gain, clamp, and persist under their keys', () => {
	const store = memoryStorage()
	withStorage({ value: store, writable: true }, () => {
		let clock = 0
		const ctx = stubContext()
		const bus = new UiSound(() => ctx, () => clock)
		bus.unlock()
		bus.setEnabled(false)
		assert.equal(store.map.get('redline-ui-sound'), 'off')
		assert.equal(ctx.gains[0].gain.value, 0)
		bus.cue('select')
		assert.equal(played(ctx).length, 0, 'a disabled bus is silent')
		bus.setEnabled(true)
		assert.equal(store.map.get('redline-ui-sound'), 'on')

		bus.setVolume(1.7)
		assert.equal(bus.getVolume(), 1)
		bus.setVolume(-2)
		assert.equal(bus.getVolume(), 0)
		bus.setVolume(Number.NaN)
		assert.equal(bus.getVolume(), 0)
		bus.setVolume(0.35)
		assert.equal(store.map.get('redline-ui-sound-vol'), '0.35')
		assert.equal(ctx.gains[0].gain.value, 0.35)
		bus.setEnabled(false)

		const again = new UiSound(() => ctx)
		assert.equal(again.isEnabled(), false)
		assert.equal(again.getVolume(), 0.35)
	})
	withStorage({ value: memoryStorage({ 'redline-ui-sound-vol': 'loud' }), writable: true }, () => {
		assert.equal(new UiSound(() => null).getVolume(), 0.8, 'a malformed stored volume falls back to the default')
	})
})

test('storage that throws, or refuses access outright, costs nothing', () => {
	const throwing = { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceededError') } }
	withStorage({ value: throwing, writable: true }, () => {
		const bus = new UiSound(() => null)
		assert.equal(bus.isEnabled(), true)
		bus.setEnabled(false)
		bus.setVolume(0.5)
		assert.equal(bus.isEnabled(), false)
		assert.equal(bus.getVolume(), 0.5)
	})
	withStorage({ get() { throw new Error('denied') } }, () => {
		const bus = new UiSound(() => null)
		bus.setVolume(0.25)
		assert.equal(bus.getVolume(), 0.25)
	})
})

test('a cue asked for while the device is still opening plays once it runs, if still fresh', async () => {
	await withStorage({ value: undefined, writable: true }, async () => {
		let clock = 0
		const ctx = stubContext({ state: 'suspended' })
		const bus = new UiSound(() => ctx, () => clock)
		const first = deferredResume(ctx)
		bus.unlock()
		assert.equal(ctx.resumes, 1)
		bus.cue('select')
		clock += 20
		bus.cue('confirm')
		assert.equal(ctx.sources.length, 0, 'nothing may be scheduled against a suspended context')
		first.settle()
		await first.promise
		await new Promise((r) => setImmediate(r))
		assert.equal(played(ctx).length, 1, 'latest wins: one cue, not a burst')
		assert.ok(sameSamples(samplesOf(played(ctx)[0]), renderUiCue('confirm', ctx.sampleRate)))

		ctx.state = 'suspended'
		const late = deferredResume(ctx)
		clock += 100
		bus.cue('select')
		clock += 400
		late.settle()
		await late.promise
		await new Promise((r) => setImmediate(r))
		assert.equal(played(ctx).length, 1, 'a cue gone stale while the device opened is dropped')
	})
})

test('dispose stops what is sounding and lets go, but leaves the context to the node', () => {
	withStorage({ value: undefined, writable: true }, () => {
		const ctx = stubContext()
		let current = ctx
		const bus = new UiSound(() => current)
		bus.cue('launch')
		const gain = ctx.gains[0]
		bus.dispose()
		assert.equal(played(ctx)[0].stopped, true)
		assert.equal(gain.to, null)
		assert.notEqual(ctx.state, 'closed')

		// The node closes its context after this; nothing is built against a closed one.
		ctx.state = 'closed'
		bus.cue('select')
		assert.equal(ctx.gains.length, 1)

		// A context the node replaced is built against afresh.
		current = stubContext()
		bus.cue('select')
		assert.equal(current.gains.length, 1)
		assert.equal(played(current).length, 1)
	})
})

process.on('exit', () => { try { rmSync(temp, { recursive: true, force: true }) } catch {} })
