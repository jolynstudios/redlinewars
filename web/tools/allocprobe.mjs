#!/usr/bin/env node
// STEELSEED — tools/allocprobe
//
// Exact managed snapshot-emission allocation gate for §4.11b.
//
// The complete per-tick sequence is pinned to one named workload, not treated as an
// upward-only budget: any movement in either direction is red and demands an explicit
// re-measurement. Player, production, movement and event observation made the old constant
// floor an incomplete model; the transient ticks are kept visible rather than averaged away.
// The C# boundary exports only its raw byte delta; this harness owns the comparison.
//
//   --falsify=above  injects one allocation inside the measured boundary
//   --falsify=below  raises one expected sample so the unchanged boundary is below it

import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME_ROOT = resolve(WEB_ROOT, '..')
const ENGINE_ROOT = join(GAME_ROOT, 'engine')
const APP_BUNDLE = join(ENGINE_ROOT, 'bin-browser', 'AppBundle')
const SERVER_SCRIPT = join(ENGINE_ROOT, 'OpenRA.Browser', 'tests', 'server.mjs')

const args = new Map(process.argv.slice(2).map(arg => {
	const [name, ...value] = arg.replace(/^--/, '').split('=')
	return [name, value.length > 0 ? value.join('=') : '1']
}))
const port = Number(args.get('port') ?? 8393)
const runs = Number(args.get('runs') ?? 5)
const warmup = Number(args.get('warmup') ?? 16)
const samples = Number(args.get('samples') ?? 64)
const expectedActors = Number(args.get('actors') ?? 8)
const timeoutMs = Number(args.get('timeout-ms') ?? 120000)
const falsify = args.get('falsify') ?? null
if (falsify !== null && !['above', 'below'].includes(falsify)) {
	console.error(`allocprobe: unknown falsifier '${falsify}'`)
	process.exit(2)
}

// Re-pinned 2026-08-09 on NullPlatform amber-crossing, seed 104729, one normal bot,
// exactly 8 spatial actors, after 16 warm-up emissions. The snapshot now observes the
// authoritative player/production catalogue, movement and event fields added after the
// 2026-08-05 248-byte pin. Five independent WASM runtimes reproduced this exact tick/value
// sequence. The floor still belongs to frozen World.SyncHash enumerable surfaces; the
// additional samples are reported by tick instead of being hidden in an average. §4.11b.
const ENGINE_ALLOC_FLOOR_BYTES = 248
const PINNED_FIRST_TICK = 16
const PINNED_SAMPLE_COUNT = 64
const PINNED_TRANSIENTS = new Map([
	[18, 664], [24, 376], [25, 320], [29, 392], [35, 592],
	[50, 304], [66, 304], [75, 360], [76, 360],
])
const expectedAtTick = tick => PINNED_TRANSIENTS.get(tick) ?? ENGINE_ALLOC_FLOOR_BYTES
const injectedBytes = falsify === 'above' ? 64 : 0
for (const [name, value, allowZero] of [
	['port', port, false], ['runs', runs, false], ['warmup', warmup, true],
	['samples', samples, false], ['actors', expectedActors, false], ['timeout-ms', timeoutMs, false],
]) {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
		console.error(`allocprobe: --${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
		process.exit(2)
	}
}
if (warmup !== PINNED_FIRST_TICK || samples !== PINNED_SAMPLE_COUNT || expectedActors !== 8) {
	console.error(
		`allocprobe: the exact gate is pinned to --warmup=${PINNED_FIRST_TICK} ` +
		`--samples=${PINNED_SAMPLE_COUNT} --actors=8`,
	)
	process.exit(2)
}

const baseUrl = `http://127.0.0.1:${port}/index.html`
const server = spawnProcessGroup(process.execPath, [
	SERVER_SCRIPT,
	'--root', APP_BUNDLE,
	'--port', String(port),
], {
	cwd: ENGINE_ROOT,
	stdio: ['ignore', 'pipe', 'pipe'],
})

let browser = null
let exitCode = 0
try {
	await waitForServer(baseUrl, 30000)
	browser = await chromium.launch({ headless: true })
	const results = []
	for (let run = 0; run < runs; run++) {
		const page = await browser.newPage()
		const pageErrors = []
		page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`))
		page.on('console', message => {
			if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
				pageErrors.push(`console.error: ${message.text()}`)
		})

		const url = new URL(baseUrl)
		url.searchParams.set('mode', 'game')
		url.searchParams.set('platform', 'null')
		url.searchParams.set('Debug.ServerRandomSeed', '104729')
		await page.goto(url.href, { waitUntil: 'load', timeout: 60000 })
		// Same dual-contract readiness as playtest: the composed AppBundle boot
		// never sets __s1_done; the legacy spike boot reports through it.
		await page.waitForFunction(
			() => globalThis.ora !== undefined && globalThis.steelseedBridge !== undefined &&
				(globalThis.__s1_done === undefined || globalThis.__s1_done.exitCode === 0),
			undefined,
			{ timeout: timeoutMs },
		)

		const result = await page.evaluate(async ({
			deadlineMs, expectedActorCount, sampleCount, warmupCount, allocationProbeBytes,
		}) => {
			const P = globalThis.ora
			const bridge = await globalThis.steelseedBridgeReady
			if (typeof P.SnapshotLastEmitAllocatedBytes !== 'function')
				throw new Error('SnapshotLastEmitAllocatedBytes export is unavailable')
			if (typeof P.SnapshotSetAllocationProbeBytes !== 'function')
				throw new Error('SnapshotSetAllocationProbeBytes export is unavailable')
			P.SnapshotSetAllocationProbeBytes(allocationProbeBytes)

			const started = String(P.StartGeneratedSkirmish(
				'seedline', 'Preset', 'amber-crossing', 'STEELWORKS', 1, 'normal',
			))
			if (!started.startsWith('ok:')) throw new Error(`skirmish start failed: ${started}`)

			const nextFrame = () => new Promise(resolveFrame => requestAnimationFrame(resolveFrame))
			const nextSnapshot = async () => {
				const deadline = performance.now() + deadlineMs
				while (performance.now() <= deadline) {
					const bytes = bridge.pollSnapshot()
					if (bytes !== null) return bytes
					await nextFrame()
				}
				throw new Error(`timed out after ${deadlineMs}ms waiting for a snapshot`)
			}

			const header = bytes => {
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
				if (view.getUint32(0, true) !== 0x504e5353) throw new Error('bad snapshot magic')
				if (view.getUint16(4, true) !== 1) throw new Error('bad snapshot version')
				const sectionCount = view.getUint16(6, true)
				let actorCount = null
				for (let i = 0; i < sectionCount; i++) {
					const entry = 32 + i * 12
					if (view.getUint16(entry, true) !== 3) continue
					actorCount = view.getUint32(view.getUint32(entry + 4, true), true)
					break
				}
				if (actorCount === null) throw new Error('snapshot has no actors section')
				return { tick: view.getUint32(12, true), actorCount }
			}

			const bytesPerEmit = []
			const ticks = []
			for (let i = 0; i < warmupCount + sampleCount; i++) {
				const snapshot = await nextSnapshot()
				const meta = header(snapshot)
				if (meta.actorCount !== expectedActorCount)
					throw new Error(`workload actor count moved ${expectedActorCount} -> ${meta.actorCount} at tick ${meta.tick}`)

				const allocated = Number(P.SnapshotLastEmitAllocatedBytes())
				if (!Number.isSafeInteger(allocated) || allocated < 0)
					throw new Error(`invalid allocated-byte delta ${allocated}`)

				if (i >= warmupCount) {
					bytesPerEmit.push(allocated)
					ticks.push(meta.tick)
				}
			}

			return {
				bytesPerEmit,
				firstTick: ticks[0],
				lastTick: ticks[ticks.length - 1],
				actorCount: expectedActorCount,
				ticks,
			}
		}, {
			deadlineMs: timeoutMs,
			expectedActorCount: expectedActors,
			sampleCount: samples,
			warmupCount: warmup,
			allocationProbeBytes: injectedBytes,
		})

		if (pageErrors.length > 0)
			throw new Error(`run ${run + 1}: ${pageErrors[0]}`)
		await page.close()
		results.push(result)
		const distinct = [...new Set(result.bytesPerEmit)].sort((a, b) => a - b)
		console.log(
			`allocprobe: run ${run + 1}/${runs} ticks=${result.firstTick}..${result.lastTick} ` +
			`actors=${result.actorCount} bytes=[${distinct.join(',')}]`,
		)
	}

	const mismatches = []
	for (let run = 0; run < results.length; run++) {
		const result = results[run]
		for (let i = 0; i < result.bytesPerEmit.length; i++) {
			const tick = result.ticks[i]
			let expected = expectedAtTick(tick)
			if (falsify === 'below' && run === 0 && i === 0) expected++
			if (tick !== PINNED_FIRST_TICK + i || result.bytesPerEmit[i] !== expected)
				mismatches.push(`run ${run + 1} tick ${tick}: measured ${result.bytesPerEmit[i]}, expected ${expected}`)
		}
	}
	if (mismatches.length > 0)
		throw new Error(`allocation sequence moved (${mismatches.slice(0, 12).join('; ')})`)

	const allSamples = results.flatMap(result => result.bytesPerEmit)
	const distinct = [...new Set(allSamples)].sort((a, b) => a - b)
	const mean = allSamples.reduce((sum, bytes) => sum + bytes, 0) / allSamples.length
	console.log(
		`allocprobe: PASS — runs=${runs} samples=${allSamples.length} ` +
		`floor=${distinct[0]} max=${distinct.at(-1)} mean=${mean.toFixed(2)} ` +
		`transientTicks=${PINNED_TRANSIENTS.size}/${PINNED_SAMPLE_COUNT} actors=${expectedActors}`,
	)
} catch (error) {
	console.error(`allocprobe: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null) await browser.close()
	await stopProcessGroup(server)
}

process.exit(exitCode)

async function waitForServer(url, deadlineMs) {
	const deadline = Date.now() + deadlineMs
	while (Date.now() <= deadline) {
		if (server.exitCode != null)
			throw new Error(`server exited ${server.exitCode} before becoming ready`)
		try {
			const response = await fetch(url)
			if (response.ok) return
		} catch {
			// Retry until the explicit deadline.
		}
		await new Promise(resolveWait => setTimeout(resolveWait, 100))
	}
	throw new Error(`server did not become ready at ${url}`)
}
