#!/usr/bin/env node
// STEELSEED — VFX baseline (vfx.md Epic 0): measure the complete running game at Ultra or Ultra+.
//
// The real WASM simulation in its worker, the UI, weather, lighting and every existing effect,
// through a live battle: the human plus three bots in two teams on a four-spawn map, maximum
// cash and the fastest speed (the battleperfgate scenario). Once two armies of 35+ stand, every
// owned unit attack-moves into the centre every two seconds while the windows are measured.
//
// Per window it records:
//   - rAF intervals (p50/p95/p99/worst, and 60 Hz refreshes missed);
//   - main-thread CPU per frame: the app's frame callback (input, snapshot intake, update,
//     render encode and submit). The simulation runs in its worker and is not in this number;
//   - GPU frame time and per-pass exclusive shares from timestamp queries (?gputime=1, with
//     WebGPU developer features so the stamps are not quantised);
//   - simulation ticks/s, actors, weapon-fire events and distinct firing actors, fx counter deltas.
// And the environment once: browser, adapter, OS, machine, power source, load, CSS viewport,
// DPR, drawing buffer, map, seed, quality, git HEAD and simBuild.
//
// It measures and asserts only that the measurement is valid: no page errors, a GPU timer
// that produced frames, and a fight that happened. Headless Chromium paces rAF from its
// compositor, not a display, so intervals show pacing, not presentation. Run on AC power with
// nothing heavy alongside; load1 is recorded either way.
//
// A diagnosis run adds --profile=1,3: those windows run under the V8 sampling profiler on the
// main thread, and the report gains their top functions by self and total time, mapped
// through the dist source maps. Sampling costs time, so a profiled report is named -profiled
// and is never a baseline. The raw .cpuprofile files go to the OS temp directory.
//
// Usage (from web/, after `vite build`):
//   node tools/vfxbaselinegate.mjs [--quality=ultra|ultra-max] [--windows=3] [--seconds=60]
//                                  [--fog=off|on] [--out=../docs/vfx/baseline] [--profile=1,3] [--gputime=0]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const QUALITY = arg('quality', 'ultra')
const WINDOWS = Number(arg('windows', 3))
const WINDOW_SECONDS = Number(arg('seconds', 60))
const FOG = arg('fog', 'off')
// `none` skips the minutes-long army build and measures the starting forces: a smoke run
// and a light-combat workload. The baseline proper waits for the armies.
const ARMIES = arg('armies', 'wait')
const OUT = resolve(import.meta.dirname, arg('out', '../../docs/vfx/baseline'))
const PROFILE_WINDOWS = arg('profile', '').split(',').filter(Boolean).map(Number)
const ARMY_TIMEOUT_MS = 20 * 60_000
const WARMUP_SECONDS = 10
const VIEWPORT = { width: 1920, height: 1080 }
assert.ok(['ultra', 'ultra-max'].includes(QUALITY), `--quality must be ultra or ultra-max, got ${QUALITY}`)
// --gputime=0 measures the CPU path as it ships: the timestamp queries wrap every pass and cost
// main-thread time of their own, so a CPU critical-path number is taken without them.
const GPU_TIMING = arg('gputime', '1') !== '0'
assert.ok(PROFILE_WINDOWS.every(w => Number.isInteger(w) && w >= 1 && w <= WINDOWS), `--profile takes window numbers 1..${WINDOWS}`)
// Only a diagnosis run needs the source maps (source-map-js arrives with vite).
const { SourceMapConsumer } = PROFILE_WINDOWS.length > 0 ? await import('source-map-js') : {}

// A V8 CPU profile reduced to its top functions by self and by total time. Positions map
// through the dist source maps to the TypeScript source. A function that recurses counts its
// total time once per stack.
const DIST_ASSETS = resolve(import.meta.dirname, '../dist/assets')
const sourceMaps = new Map()
const originalOf = frame => {
	const file = frame.url.split('?')[0].split('/').pop()
	if (!file?.endsWith('.js')) return null
	if (!sourceMaps.has(file)) {
		try { sourceMaps.set(file, new SourceMapConsumer(JSON.parse(readFileSync(join(DIST_ASSETS, `${file}.map`), 'utf8')))) }
		catch { sourceMaps.set(file, null) }
	}
	const pos = sourceMaps.get(file)?.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber })
	return pos?.source ? `${pos.source.replace(/^(\.\.\/)+/, '')}:${pos.line}` : `${file}:${frame.lineNumber + 1}`
}
function summarizeProfile(profile, top = 20) {
	const byId = new Map(profile.nodes.map(n => [n.id, n])), selfById = new Map(), totalById = new Map()
	for (let i = 0; i < profile.samples.length; i++)
		selfById.set(profile.samples[i], (selfById.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0))
	const totalOf = id => {
		if (!totalById.has(id)) totalById.set(id, (selfById.get(id) ?? 0) + (byId.get(id).children ?? []).reduce((t, c) => t + totalOf(c), 0))
		return totalById.get(id)
	}
	const self = new Map(), total = new Map(), frames = new Map()
	const walk = (id, onStack) => {
		const node = byId.get(id), f = node.callFrame, key = `${f.functionName}|${f.url}|${f.lineNumber}|${f.columnNumber}`
		frames.set(key, f)
		self.set(key, (self.get(key) ?? 0) + (selfById.get(id) ?? 0))
		const outermost = !onStack.has(key)
		if (outermost) { total.set(key, (total.get(key) ?? 0) + totalOf(id)); onStack.add(key) }
		for (const c of node.children ?? []) walk(c, onStack)
		if (outermost) onStack.delete(key)
	}
	walk(profile.nodes[0].id, new Set())
	const durationUs = profile.endTime - profile.startTime
	const special = name => self.get([...frames.keys()].find(k => k.startsWith(`${name}|`)) ?? '') ?? 0
	const row = ([key, us]) => {
		const f = frames.get(key)
		return { fn: f.functionName || '(anonymous)', at: f.url ? originalOf(f) : '', ms: +(us / 1000).toFixed(1), pct: +(100 * us / durationUs).toFixed(1) }
	}
	const ranked = (map, skip) => [...map].filter(([k]) => !skip.some(s => k.startsWith(`${s}|`))).sort((a, b) => b[1] - a[1]).slice(0, top).map(row)
	return {
		durationMs: +(durationUs / 1000).toFixed(0), idleMs: +(special('(idle)') / 1000).toFixed(0),
		gcMs: +(special('(garbage collector)') / 1000).toFixed(0), programMs: +(special('(program)') / 1000).toFixed(0),
		topSelf: ranked(self, ['(root)', '(idle)']), topTotal: ranked(total, ['(root)', '(idle)', '(program)', '(garbage collector)']),
	}
}
assert.ok(['on', 'off'].includes(FOG), `--fog must be on or off, got ${FOG}`)
assert.ok(['wait', 'none'].includes(ARMIES), `--armies must be wait or none, got ${ARMIES}`)

const repo = resolve(import.meta.dirname, '../..')
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim() } catch { return 'n/a' } }
const environment = {
	measuredAt: new Date().toISOString(),
	git: { head: sh('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']), branch: sh('git', ['-C', repo, 'branch', '--show-current']),
		dirty: sh('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no']).length > 0 },
	simBuild: JSON.parse(readFileSync(join(repo, 'engine/steelseed-host/generated/build.json'), 'utf8')).simBuild,
	machine: { model: sh('sysctl', ['-n', 'hw.model']), cpu: cpus()[0]?.model ?? 'n/a', cores: cpus().length },
	os: `${sh('sw_vers', ['-productName'])} ${sh('sw_vers', ['-productVersion'])} (${sh('uname', ['-m'])})`,
	power: sh('pmset', ['-g', 'batt']).split('\n')[0],
	loadavgAtStart: loadavg().map(v => +v.toFixed(2)),
	quality: QUALITY, fog: FOG, armies: ARMIES, viewportCss: VIEWPORT, windows: WINDOWS, windowSeconds: WINDOW_SECONDS,
}

let preview, browser
try {
	preview = await startPrivateComposed(8493)
	;({ browser } = await launchGpuBrowser(await loadChromium('vfxbaselinegate'), 'vfxbaselinegate', ['--enable-webgpu-developer-features']))
	environment.browser = `${browser.browserType().name()} ${browser.version()}`
	const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
	const page = await context.newPage()
	// Failed loads are recorded by URL instead of failing the run: a loopback server has
	// no room directory. The bundle names the production account origin, whose CORS refuses
	// loopback, so /api/me answers as production does for a signed-out visitor (composedgate).
	const errors = [], failedLoads = []
	page.on('response', r => { if (r.status() >= 400) failedLoads.push(`${r.status()} ${r.url()}`) })
	page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
	page.on('console', m => {
		const text = m.text()
		if (text.startsWith('[boot] gpu adapter')) environment.adapter = text.slice('[boot] gpu adapter '.length)
		if (m.type() !== 'error' || text.startsWith('Failed to load resource')) return
		errors.push(`console: ${text.slice(0, 200)}`)
	})
	await page.route('**/api/me', route => route.fulfill({
		status: 200, contentType: 'application/json', body: '{"user":null}',
		headers: { 'access-control-allow-origin': new URL(preview.baseUrl).origin, 'access-control-allow-credentials': 'true' },
	}))
	await page.goto(`${preview.baseUrl}&quality=${QUALITY}${GPU_TIMING ? '&gputime=1' : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 200 })
	const catalog = await page.evaluate(async () => await globalThis.steelseed.ctx.session.getCatalog())
	const map = catalog.maps.find(m => m.title === 'Altercation') ?? catalog.maps.find(m => m.spawnPoints.length >= 4)
	if (!map) throw new Error('no four-spawn map in the catalog')
	const config = configFor(catalog, map, { withBot: false })
	let spawn = 1
	const factionOf = (descriptor, index) => descriptor.locks.faction
		? descriptor.defaults.faction
		: (map.factions.find(f => f.id === descriptor.defaults.faction)?.id ?? map.factions[index % map.factions.length]?.id ?? descriptor.defaults.faction)
	config.slots = map.slots.map((descriptor, index) => ({
		slot: descriptor.id,
		kind: index === 0 ? 'human' : index <= 3 ? 'bot' : 'closed',
		botType: index === 0 ? '' : (map.bots.find(b => b.id === 'normal')?.id ?? map.bots[0]?.id ?? ''),
		faction: factionOf(descriptor, index),
		color: descriptor.locks.color ? descriptor.defaults.color : map.colors[index % map.colors.length],
		team: index <= 1 ? 1 : 2,
		spawn: descriptor.locks.spawn ? descriptor.defaults.spawn : spawn++,
	}))
	config.local = { ...config.local, slot: map.slots[0].id, faction: factionOf(map.slots[0], 0), team: 1, spawn: 1 }
	const speeds = map.options.find(o => o.id === 'gamespeed')?.values ?? []
	const fastest = [...speeds.map(v => v.id)].filter(Boolean).pop() ?? 'fastest'
	Object.assign(config.options, {
		startingunits: 'heavy',
		startingcash: [...(map.options.find(o => o.id === 'startingcash')?.values ?? []).map(v => v.id)].filter(Boolean).pop(),
		gamespeed: fastest,
		fog: FOG === 'on' ? 'True' : 'False',
		explored: FOG === 'on' ? 'False' : 'True',
		crates: 'False',
	})
	environment.map = { title: map.title, uid: map.uid, seed: config.randomSeed, gamespeed: fastest }
	const started = await page.evaluate(async c => await globalThis.steelseed.ctx.session.startSkirmish(c), config)
	if (started?.status === 'error') throw new Error(`start failed: ${started.code}: ${started.userMessage}`)
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.snapshot?.actors?.count > 0 && document.getElementById('session-ui')?.hidden, undefined, { timeout: 180000, polling: 200 })

	const armies = await page.evaluate(async ({ timeoutMs }) => {
		const app = globalThis.steelseed
		const ownedBy = () => {
			const snap = app.ctx.snapshot, counts = new Map()
			for (let i = 0; i < snap.actors.count; i++) {
				const name = app.ctx.actorTypeName(snap.actors.typeId[i])
				if (!name || snap.actors.health[i] <= 0) continue
				if (/^(e\d|1tnk|2tnk|3tnk|4tnk|jeep|apc|ftrk|arty|v2rl|mnly|ttnk|shok|e7|dday|MNST|DDOK)/i.test(name) === false) continue
				counts.set(snap.actors.owner[i], (counts.get(snap.actors.owner[i]) ?? 0) + 1)
			}
			return counts
		}
		const t0 = performance.now()
		let counts = ownedBy(), gameOver = false
		while (performance.now() - t0 < timeoutMs) {
			counts = ownedBy()
			const values = [...counts.values()], total = values.reduce((a, b) => a + b, 0)
			gameOver = (app.ctx.snapshot.flags & 8) !== 0
			if (gameOver) break
			if (values.filter(n => n >= 35).length >= 2 && total >= 80) break
			await new Promise(r => setTimeout(r, 2000))
		}
		return { counts: [...counts.entries()], waitedMs: Math.round(performance.now() - t0), gameOver }
	}, { timeoutMs: ARMIES === 'wait' ? ARMY_TIMEOUT_MS : 0 }, { timeout: ARMY_TIMEOUT_MS + 30000 })
	assert.equal(armies.gameOver, false, 'the match ended before the armies stood')

	// The page starts and stops the main-thread sampling profiler at its window edges.
	const profiles = new Map()
	if (PROFILE_WINDOWS.length > 0) {
		const cdp = await context.newCDPSession(page)
		await cdp.send('Profiler.enable')
		await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
		await page.exposeFunction('__vfxProfile', async (command, window) => {
			if (command === 'start') await cdp.send('Profiler.start')
			else profiles.set(window, (await cdp.send('Profiler.stop')).profile)
		})
	}

	const measured = await page.evaluate(async ({ windows, windowSeconds, warmupSeconds, profileWindows }) => {
		const app = globalThis.steelseed, fx = app.ctx.get('fx'), render = app.ctx.get('render')
		const world = app.ctx.snapshot.world
		const cx = (world.boundsLeft + world.boundsRight) >> 1, cz = (world.boundsTop + world.boundsBottom) >> 1
		const owned = () => {
			const snap = app.ctx.snapshot, ids = []
			for (let i = 0; i < snap.actors.count; i++)
				if (snap.actors.owner[i] === snap.world.renderPlayer && snap.actors.health[i] > 0) ids.push(snap.actors.id[i])
			return ids
		}
		// Orders go out on simulation ticks, not wall-clock seconds, so two runs of one build
		// and seed fight the same battle as closely as the worker's order latency allows.
		let orders = 0, nextOrderTick = app.ctx.snapshot.tick
		const charge = setInterval(() => {
			if (app.ctx.snapshot.tick < nextOrderTick) return
			nextOrderTick = app.ctx.snapshot.tick + 50
			const ids = owned()
			if (ids.length === 0) return
			app.ctx.issueOrder({ orderString: 'Contextual', contextual: true, subjectIds: Uint32Array.from(ids), subjectCount: ids.length,
				targetActorId: 0, targetCell: { x: cx + (orders % 5) - 2, y: cz + (orders % 3) - 1 }, targetFrozen: false, modifiers: 1 })
			orders++
		}, 100)
		// Main-thread CPU per frame: wrap the app's own frame callback (it re-arms itself by name).
		let cpu = []
		const frame = app.tickFrame
		app.tickFrame = now => { const t0 = performance.now(); frame(now); cpu.push(performance.now() - t0) }
		// The fx node's own CPU per frame (vfx.md Epic 10, "incremental VFX CPU"): its whole update,
		// every effect old and new, so an upper bound on what the VFX program added.
		let fxCpu = []
		const fxUpdate = fx.update
		fx.update = function (dt, ctx) { const t0 = performance.now(); fxUpdate.call(this, dt, ctx); fxCpu.push(performance.now() - t0) }
		let intervals = [], lastFrame = performance.now(), sampling = true
		const raf = ts => { intervals.push(ts - lastFrame); lastFrame = ts; if (sampling) requestAnimationFrame(raf) }
		requestAnimationFrame(raf)
		let lastBeat = performance.now(), maxGap = 0
		const heartbeat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - lastBeat); lastBeat = now }, 5)
		let fires = 0, firing = new Set()
		const offFire = app.events.on('sim:weapon:fire', e => {
			fires++
			const view = app.ctx.snapshot?.view
			if (view && e && typeof e.offset === 'number') firing.add(view.getUint32(e.offset, true))
		})
		const stats = () => ({ ...fx.stats })
		const pct = (values, p) => {
			const sorted = [...values].sort((a, b) => a - b)
			return sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2) : null
		}
		const summary = values => ({ p50: pct(values, .5), p95: pct(values, .95), p99: pct(values, .99), worst: pct(values, 1), n: values.length })
		await new Promise(r => setTimeout(r, warmupSeconds * 1000))
		const results = []
		for (let w = 0; w < windows; w++) {
			cpu = []; fxCpu = []; intervals = []; maxGap = 0; fires = 0; firing = new Set(); lastFrame = performance.now()
			const fx0 = stats(), tick0 = app.ctx.snapshot.tick, actors0 = app.ctx.snapshot.actors.count
			const gpuFrame0 = render.gpuTimer?.latest?.frame ?? 0, t0 = performance.now()
			// The timer keeps only its last 600 frames, so they are collected as they complete:
			// reading the history once at the end would describe the window's last seconds only.
			const gpu = [], gpuSeen = new Set()
			const pullGpu = () => {
				for (const f of render.gpuTimer?.history ?? [])
					if (f.frame > gpuFrame0 && !gpuSeen.has(f.frame)) { gpuSeen.add(f.frame); gpu.push(f) }
			}
			const profiled = profileWindows.includes(w + 1)
			if (profiled) await globalThis.__vfxProfile('start', w + 1)
			// A window ends early when the match is over or the world stops ticking: an end
			// screen or a frozen world is not the game this baseline claims to measure.
			let truncated = null, lastTick = tick0, lastTickAt = t0
			while (performance.now() - t0 < windowSeconds * 1000) {
				await new Promise(r => setTimeout(r, 250))
				pullGpu()
				const snap = app.ctx.snapshot
				if ((snap.flags & 8) !== 0) { truncated = 'game-over'; break }
				if (snap.tick !== lastTick) { lastTick = snap.tick; lastTickAt = performance.now() }
				else if (performance.now() - lastTickAt > 2000) { truncated = 'sim-stalled'; break }
			}
			const elapsed = (performance.now() - t0) / 1000, fx1 = stats()
			if (profiled) await globalThis.__vfxProfile('stop', w + 1)
			pullGpu()
			const shares = {}
			for (const f of gpu) for (const p of f.passes) shares[p.label] = (shares[p.label] ?? 0) + p.exclusiveMs
			for (const k of Object.keys(shares)) shares[k] = +(shares[k] / Math.max(1, gpu.length)).toFixed(3)
			const fxDelta = {}
			for (const k of Object.keys(fx1)) if (typeof fx1[k] === 'number' && /^(accepted|started|dropped|malformed|unpaired|paired|evicted|trailPuffs|muzzleSmoke|impactVocabulary)/.test(k)) fxDelta[k] = fx1[k] - (fx0[k] ?? 0)
			results.push({
				window: w + 1, seconds: +elapsed.toFixed(1), truncated,
				raf: { ...summary(intervals), missed60: intervals.reduce((n, iv) => n + Math.max(0, Math.round(iv / (1000 / 60)) - 1), 0) },
				cpuFrameMs: summary(cpu),
				fxCpuMs: summary(fxCpu),
				gpuFrameMs: { ...summary(gpu.map(f => f.totalMs)), exclusiveMeanMs: shares },
				gpuTimer: { skipped: render.gpuTimer?.skipped ?? null, failed: render.gpuTimer?.failed ?? null },
				sim: { ticksPerSecond: +((app.ctx.snapshot.tick - tick0) / elapsed).toFixed(1), actorsStart: actors0, actorsEnd: app.ctx.snapshot.actors.count },
				combat: { weaponFireEvents: fires, firingActors: firing.size, ordersIssued: orders },
				fx: fxDelta, fxLive: { active: fx1.active, visible: fx1.visible, lights: fx1.lights },
				maxMainThreadGapMs: +maxGap.toFixed(0),
				frameStats: { ...app.frameStats },
			})
			if (truncated) break
		}
		sampling = false; clearInterval(charge); clearInterval(heartbeat); offFire(); app.tickFrame = frame; fx.update = fxUpdate
		return {
			results,
			canvas: { cssWidth: app.ctx.canvas.clientWidth, cssHeight: app.ctx.canvas.clientHeight, width: app.ctx.canvas.width, height: app.ctx.canvas.height, dpr: devicePixelRatio },
			config: { quality: app.config.q?.name ?? null, choice: app.config.graphicsChoice, gpuTiming: app.config.gpuTiming },
			gameOver: (app.ctx.snapshot.flags & 8) !== 0,
		}
	}, { windows: WINDOWS, windowSeconds: WINDOW_SECONDS, warmupSeconds: WARMUP_SECONDS, profileWindows: PROFILE_WINDOWS },
	{ timeout: (WARMUP_SECONDS + WINDOWS * (WINDOW_SECONDS + 5)) * 1000 + 60000 })

	environment.loadavgAtEnd = loadavg().map(v => +v.toFixed(2))
	const stamp = environment.measuredAt.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
	const name = `${stamp}-${QUALITY}-fog${FOG}${ARMIES === 'none' ? '-starting-forces' : ''}${GPU_TIMING ? '' : '-no-gpu-timer'}${PROFILE_WINDOWS.length > 0 ? '-profiled' : ''}`
	const profileSummaries = {}
	for (const [window, profile] of [...profiles].sort((a, b) => a[0] - b[0])) {
		const raw = join(tmpdir(), `vfxbaselinegate-${name}-w${window}.cpuprofile`)
		writeFileSync(raw, JSON.stringify(profile))
		profileSummaries[window] = { ...summarizeProfile(profile), raw }
		console.log(`vfxbaselinegate: window ${window} profile at ${raw}`)
	}
	const record = { tool: 'vfxbaselinegate', environment, armies, ...measured, profiles: profileSummaries, errors, failedLoads }
	mkdirSync(OUT, { recursive: true })
	const base = join(OUT, name)
	writeFileSync(`${base}.json`, JSON.stringify(record, null, '\t') + '\n')
	const profileLines = Object.entries(profileSummaries).flatMap(([window, p]) => [
		`## Main-thread profile, window ${window} (0.5 ms sampling; this window's timings carry the sampling cost)`, '',
		`${p.durationMs} ms profiled: idle ${p.idleMs} ms, garbage collector ${p.gcMs} ms, program ${p.programMs} ms.`, '',
		'| Self ms | % | Function | Source |', '|---|---|---|---|',
		...p.topSelf.map(r => `| ${r.ms} | ${r.pct} | \`${r.fn}\` | ${r.at} |`), '',
		'| Total ms | % | Function | Source |', '|---|---|---|---|',
		...p.topTotal.map(r => `| ${r.ms} | ${r.pct} | \`${r.fn}\` | ${r.at} |`), '',
	])
	const row = r => `| ${r.window} (${r.seconds} s${r.truncated ? `, ${r.truncated}` : ''}) | ${r.raf.p50} / ${r.raf.p95} / ${r.raf.p99} / ${r.raf.worst} | ${r.raf.missed60} | ${r.cpuFrameMs.p50} / ${r.cpuFrameMs.p95} / ${r.cpuFrameMs.p99} | ${r.fxCpuMs?.p50 ?? 'n/a'} / ${r.fxCpuMs?.p95 ?? 'n/a'} | ${r.gpuFrameMs.p50} / ${r.gpuFrameMs.p95} / ${r.gpuFrameMs.p99} | ${r.gpuFrameMs.n} / ${r.cpuFrameMs.n} | ${r.sim.ticksPerSecond} | ${r.sim.actorsStart}→${r.sim.actorsEnd} | ${r.combat.weaponFireEvents} / ${r.combat.firingActors} | ${r.fx.acceptedImpactEvents ?? 'n/a'} |`
	writeFileSync(`${base}.md`, [
		`# VFX ${PROFILE_WINDOWS.length > 0 ? 'diagnosis (profiled, not a baseline)' : 'baseline'} — ${QUALITY}, fog ${FOG} (${environment.measuredAt})`, '',
		`- Build: \`${environment.git.head}\` on \`${environment.git.branch}\`${environment.git.dirty ? ' (tracked changes present)' : ''}, simBuild \`${environment.simBuild}\``,
		`- Machine: ${environment.machine.model}, ${environment.machine.cpu}; ${environment.os}; ${environment.power}; load1 ${environment.loadavgAtStart[0]} → ${environment.loadavgAtEnd[0]}`,
		`- Browser: ${environment.browser} (headless; rAF paced by the compositor, not a display); adapter: ${environment.adapter ?? 'n/a'}`,
		`- Canvas: CSS ${measured.canvas.cssWidth}×${measured.canvas.cssHeight}, drawing buffer ${measured.canvas.width}×${measured.canvas.height}, DPR ${measured.canvas.dpr}`,
		`- Scenario: ${environment.map.title} (${environment.map.gamespeed}), seed ${environment.map.seed}; armies ${JSON.stringify(armies.counts)} after ${Math.round(armies.waitedMs / 1000)} s`,
		'', '| Window | rAF p50/p95/p99/worst ms | missed 60 Hz | CPU frame p50/p95/p99 ms | fx CPU p50/p95 ms | GPU frame p50/p95/p99 ms | GPU-timed / drawn frames | ticks/s | actors | fire events / firing actors | impact events |',
		'|---|---|---|---|---|---|---|---|---|---|---|', ...measured.results.map(row), '',
		'GPU exclusive pass shares (mean ms, window 1): ' + Object.entries(measured.results[0]?.gpuFrameMs.exclusiveMeanMs ?? {}).map(([k, v]) => `${k.replace('render.pass.', '')} ${v}`).join(', '), '',
		`Page errors: ${errors.length === 0 ? 'none' : errors.join('; ')}. Failed loads: ${failedLoads.length === 0 ? 'none' : failedLoads.join('; ')}`, '',
		...profileLines,
	].join('\n'))
	console.log('vfxbaselinegate measured', JSON.stringify({ quality: QUALITY, fog: FOG, windows: measured.results.map(r => ({ raf95: r.raf.p95, missed60: r.raf.missed60, cpu95: r.cpuFrameMs.p95, fxCpu95: r.fxCpuMs.p95, gpu95: r.gpuFrameMs.p95, fires: r.combat.weaponFireEvents, impacts: r.fx.acceptedImpactEvents })) }))
	console.log(`vfxbaselinegate: wrote ${base}.json and .md`)
	assert.deepEqual(errors, [], 'no page errors during the measurement')
	if (GPU_TIMING) assert.equal(measured.config.gpuTiming, true, 'the adapter did not grant timestamp-query; GPU time would be unmeasured')
	if (GPU_TIMING) assert.ok(measured.results.every(r => r.gpuFrameMs.n >= .8 * r.cpuFrameMs.n),
		'GPU time must cover the window: at least 80% of its drawn frames timed')
	assert.ok(measured.results.some(r => r.combat.weaponFireEvents > 0), 'no weapon fired: the battle did not happen')
	console.log(`vfxbaselinegate: PASS — ${QUALITY}, fog ${FOG}, ${WINDOWS}×${WINDOW_SECONDS} s measured`)
} finally {
	await browser?.close()
	await preview?.close?.()
}
