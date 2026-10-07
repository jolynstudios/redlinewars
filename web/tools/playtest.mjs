#!/usr/bin/env node
// STEELSEED — tools/playtest
// Fixed-seed live simulation gate. Runs the same text-scripted skirmish twice,
// executes the §1.4 text order-script one line at a time, and compares every
// observed sync hash plus actor-state signature.
//
// Usage:
//   node tools/playtest.mjs [--script path] [--max-ticks n] [--port n] [--url u]
//                           [--timeout-ms n] [--keep-server]
//                           [--bridge-fields] [--only field] [--falsify field]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME_ROOT = resolve(WEB_ROOT, '..')
const ENGINE_ROOT = join(GAME_ROOT, 'engine')
const APP_BUNDLE = join(ENGINE_ROOT, 'bin-browser', 'AppBundle')
const SERVER_SCRIPT = join(ENGINE_ROOT, 'OpenRA.Browser', 'tests', 'server.mjs')
const DEFAULT_SCRIPT = join(WEB_ROOT, 'tools', 'replays', 'playtest.orders.json')
const DEFAULT_BRIDGE_SCRIPT = join(WEB_ROOT, 'tools', 'replays', 'bridge-fields.orders.json')
const bridgeFieldNames = new Set(['speed', 'firing', 'progress', 'altitude', 'events', 'projectiles', 'outcome'])

const flags = parseFlags(process.argv.slice(2))
const value = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const bridgeFields = flags.has('bridge-fields')
const bridgeOnly = value('only', null)
const bridgeFalsify = value('falsify', null)
if ((bridgeOnly != null && !bridgeFieldNames.has(bridgeOnly)) ||
	(bridgeFalsify != null && !bridgeFieldNames.has(bridgeFalsify)))
	throw new Error(`playtest: unknown bridge field '${bridgeOnly ?? bridgeFalsify}'`)
if (!bridgeFields && (bridgeOnly != null || bridgeFalsify != null))
	throw new Error('playtest: --only/--falsify require --bridge-fields')
// Most field witnesses use the broad bridge exercise, but outcome can only be observed
// in the decisive script. The former legitimately remains live at tick 2400 and therefore
// cannot prove won/lost flags no matter how long the harness samples it.
const defaultScript = bridgeFields && bridgeOnly !== 'outcome' && bridgeFalsify !== 'outcome'
	? DEFAULT_BRIDGE_SCRIPT
	: DEFAULT_SCRIPT
const scriptPath = resolve(value('script', defaultScript))
const maxTicks = positiveInteger(value('max-ticks', 2400), 'max-ticks')
const timeoutMs = positiveInteger(value('timeout-ms', 120000), 'timeout-ms')
const port = positiveInteger(value('port', 8386), 'port')
const suppliedUrl = value('url', null)
const scriptText = readFileSync(scriptPath, 'utf8')
const script = JSON.parse(scriptText)
validateScript(script)
const bridgeStopTick = bridgeOnly == null ? maxTicks : Math.min(maxTicks, {
	speed: 100,
	firing: 220,
	progress: 100,
	altitude: 1400,
	events: 220,
	projectiles: 10,
	outcome: 2400,
}[bridgeOnly])

let chromium
try {
	;({ chromium } = await import('playwright'))
} catch {
	console.error(
		'playtest: playwright is not installed; run ' +
			'`cd web && npm install && npx playwright install chromium`',
	)
	process.exit(2)
}

const baseUrl = suppliedUrl ?? `http://127.0.0.1:${port}/index.html`
let server = null
let browser = null
let exitCode = 0

try {
	if (suppliedUrl == null) {
		server = spawnProcessGroup(process.execPath, [
			SERVER_SCRIPT,
			'--root', APP_BUNDLE,
			'--port', String(port),
		], {
			cwd: ENGINE_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		await waitForServer(baseUrl, 30000, server)
	}

	browser = await launchBrowser()
	console.log(
		`playtest: '${script.name}', seed=${script.serverSeed}, maxTicks=${maxTicks}, two fresh runs`,
	)
	const a = await runScenario(browser, 'run A')
	assertRequiredBuiltTypes(a, bridgeOnly)
	if (bridgeFalsify != null) {
		assertBridgeFields(a.bridgeMetrics, bridgeOnly)
		throw new Error(`bridge ${bridgeFalsify} falsifier failed to make its witness red`)
	}
	const b = await runScenario(browser, 'run B')
	assertRequiredBuiltTypes(b, bridgeOnly)
	const divergence = firstDivergence(a.samples, b.samples)
	if (divergence != null)
		throw new Error(
			`determinism diverged at tick ${divergence.tick}: ` +
				`A=${divergence.a ?? '(missing)'} B=${divergence.b ?? '(missing)'}`,
		)

	console.log(
		`playtest: deterministic — ${a.samples.length}/${b.samples.length} tick signatures exact, ` +
			`ticks ${a.samples[0].tick}..${a.samples.at(-1).tick}`,
	)
	console.log(`playtest: ${bridgeFields ? 'sampled' : 'decided'} — ${a.state.split('\n')[0]}`)
	for (const line of a.state.split('\n').slice(1))
		console.log(`playtest:   ${line}`)
	console.log(
		`playtest: actor stream finite/sorted on ${a.snapshotCount} snapshots; ` +
			`${a.movedSubjects}/${a.subjectCount} scripted subjects moved; ` +
			`${a.actionResults.length} script lines executed; built ${a.builtTypes.join(', ')}`,
	)
	for (const action of a.actionResults)
		console.log(
			`playtest:   tick ${action.tick} ${action.phase}/${action.order} -> ` +
				`${action.result} [${action.line}]`,
		)
	if (bridgeFields) {
		assertBridgeFields(a.bridgeMetrics, bridgeOnly)
		assertBridgeFields(b.bridgeMetrics, bridgeOnly)
		console.log(
			`playtest: bridge fields — speed samples=${a.bridgeMetrics.positiveSpeedSamples}, ` +
			`max |speed-Δpos|=${a.bridgeMetrics.maxSpeedError.toFixed(3)} WDist; ` +
			`firing samples=${a.bridgeMetrics.firingSamples}; ` +
			`prod max=${a.bridgeMetrics.maxProduction}; ` +
			`aircraft samples=${a.bridgeMetrics.aircraftSamples}, ` +
			`maxZ=${a.bridgeMetrics.maxAircraftZ}; ` +
			`events=${a.bridgeMetrics.eventCount} [${formatEventKinds(a.bridgeMetrics.eventKinds)}]; ` +
			`projectiles present=${a.bridgeMetrics.projectileFrames}/${a.snapshotCount}, ` +
			`max count=${a.bridgeMetrics.maxProjectileCount}; ` +
			`outcome samples=${a.bridgeMetrics.outcomeSamples}`,
		)
	}
	console.log(`playtest: host/sim callback ${formatTimings(a.tickTimings)}`)
	console.log(bridgeFields
		? 'playtest: PASS — bridge field script sampled from two byte-identical fixed-seed runs'
		: 'playtest: PASS — complete text order-script executed and match decided')
} catch (error) {
	console.error(`playtest: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null)
		await browser.close()
	if (server != null && !flags.has('keep-server'))
		await stopProcessGroup(server)
}

process.exit(exitCode)

async function runScenario(activeBrowser, label) {
	const context = await activeBrowser.newContext({
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	await context.addInitScript(() => {
		const nativeRequestAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis)
		globalThis.__s1_simTickTimings = []
		const probeTick = () => {
			try {
				const raw = String(globalThis.ora?.GetSyncProbe?.() ?? '')
				const match = /^tick=(\d+) hash=/.exec(raw)
				return match == null ? -1 : Number(match[1])
			} catch {
				return -1
			}
		}
		globalThis.requestAnimationFrame = callback => nativeRequestAnimationFrame(timestamp => {
			const before = probeTick()
			const start = performance.now()
			const result = callback(timestamp)
			const elapsed = performance.now() - start
			const after = probeTick()
			const delta = after - before
			if (before >= 0 && delta > 0) {
				const perTick = elapsed / delta
				for (let i = 0; i < delta; i++)
					globalThis.__s1_simTickTimings.push(perTick)
			}
			return result
		})
	})
	const page = await context.newPage()
	const errors = []
	page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
	page.on('console', message => {
		if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
			errors.push(`console.error: ${message.text()}`)
	})
	page.on('response', response => {
		if (response.status() < 400 || new URL(response.url()).pathname === '/favicon.ico')
			return
		errors.push(`HTTP ${response.status()}: ${response.url()}`)
	})

	try {
		const url = new URL(baseUrl)
		url.searchParams.set('mode', 'game')
		url.searchParams.set('platform', 'null')
		url.searchParams.set('Debug.ServerRandomSeed', String(script.serverSeed))
		await page.goto(url.href, { waitUntil: 'load', timeout: 60000 })
		// The composed AppBundle boot (Sep 7) never sets __s1_done; readiness is
		// `ora` + `steelseedBridge` appearing. The legacy spike boot still reports
		// through __s1_done and can fail with a non-zero exit there. Accept both.
		await page.waitForFunction(
			() => globalThis.ora !== undefined && globalThis.steelseedBridge !== undefined &&
				(globalThis.__s1_done === undefined || globalThis.__s1_done.exitCode === 0),
			undefined,
			{ timeout: 120000 },
		)

		const surface = await page.evaluate(async () => {
			const bridge = await globalThis.steelseedBridgeReady
			return {
				start: typeof globalThis.ora?.StartGeneratedSkirmish,
				state: typeof globalThis.ora?.GetMatchState,
				probe: typeof globalThis.ora?.GetSyncProbe,
				poll: typeof bridge?.pollSnapshot,
				issue: typeof bridge?.issueOrder,
				runLine: typeof globalThis.ora?.RunOrderScriptLine,
				types: typeof bridge?.snapshotTypeTable,
			}
		})
		// The legacy generated-skirmish seam (StartGeneratedSkirmish / RunOrderScriptLine /
		// GetMatchState) was dropped in the browser-host rewrite. The modern host starts
		// skirmishes through the lobby session (Program.Skirmish.cs StartSkirmish(configJson),
		// driven by collectStartConfig in ui) and the page issues orders via
		// bridge.issueOrder. Rebuilding this harness on that seam is a tracked follow-up —
		// fail fast with the reason instead of an RPC crash three minutes into the match.

		const s = script.scenario
		// The interop namespace is a dispatch proxy: typeof lies 'function' for every
		// member, and a missing export only surfaces when the C# side rejects the RPC.
		const started = await page.evaluate(
			scenario => globalThis.ora.StartGeneratedSkirmish(
				scenario.generatorType,
				scenario.optionId,
				scenario.presetChoice,
				scenario.tileset,
				scenario.botCount,
				scenario.botType,
			),
			s,
		).catch(error => {
			throw new Error(
				`${label}: SKIP — the legacy generated-skirmish seam is gone. The ` +
					`browser-host rewrite starts skirmishes through the lobby session ` +
					`(Program.Skirmish.cs StartSkirmish(configJson), driven by ui ` +
					`collectStartConfig) and issues orders via bridge.issueOrder; ` +
					`RunOrderScriptLine/GetMatchState have no modern equivalent yet. ` +
					`Rebuild this harness onto that seam before the determinism compare. ` +
					`Underlying error: ${error?.message ?? error}`,
			)
		})
			throw new Error(`${label}: StartGeneratedSkirmish returned ${started}`)

		const capture = await page.evaluate(
			async ({ orderScript, tickLimit, deadlineMs, measureBridgeFields, falsifyBridgeField }) => {
				const P = globalThis.ora
				const bridge = await globalThis.steelseedBridgeReady
				const samples = []
				const actionResults = []
				const initial = new Map()
				const latest = new Map()
				const subjects = new Set()
				const initialActorIds = new Set()
				const builtTypes = new Set()
				const commandTypes = new Set(
					orderScript.orders
						.filter(order => order.target === 'enemy-command')
						.flatMap(order => order.targetTypes ?? []),
				)
				const reservedBuildCells = new Set()
				let enemyCommand = null
				let snapshotCount = 0
				let lastTick = -1
				let terrain = null
				let previousPositions = new Map()
				const bridgeMetrics = {
					maxSpeedError: 0,
					positiveSpeedSamples: 0,
					firingSamples: 0,
					maxProduction: 0,
					aircraftSamples: 0,
					maxAircraftZ: 0,
					eventCount: 0,
					eventKinds: {},
					projectileFrames: 0,
					maxProjectileCount: 0,
					outcomeSamples: 0,
				}
				const deadline = performance.now() + deadlineMs
				const pending = orderScript.orders.slice()

				const nextFrame = () => new Promise(resolveFrame => requestAnimationFrame(resolveFrame))
				const parseProbe = raw => {
					if (String(raw).includes('world=null'))
						return null
					const match = /^tick=(\d+) hash=(\d+)$/.exec(String(raw).trim())
					if (match == null)
						throw new Error(`GetSyncProbe returned '${raw}'`)
					return { tick: Number(match[1]), hash: Number(match[2]) >>> 0 }
				}

				while (performance.now() <= deadline) {
					const probe = parseProbe(P.GetSyncProbe())
					if (probe == null) {
						await nextFrame()
						continue
					}
					if (probe.tick < lastTick)
						throw new Error(`world tick moved backwards ${lastTick}->${probe.tick}`)
					if (probe.tick === lastTick) {
						await nextFrame()
						continue
					}
					lastTick = probe.tick

					const memory = bridge.pollSnapshot()
					if (memory === null)
						throw new Error(
							`pollSnapshot returned null at new tick ${probe.tick}: ${P.BridgeDiagnostics()}`,
						)
					const byteLength = new DataView(
						memory.buffer,
						memory.byteOffset,
						memory.byteLength,
					).getUint32(8, true)
					const bytes = memory.subarray(0, byteLength)
					const frame = decodeFrame(bytes)
					snapshotCount++
					validateFrame(frame, probe.tick)
					if (frame.terrain != null)
						terrain = frame.terrain
					const typeNames = String(bridge.snapshotTypeTable()).split('\n')
					if (measureBridgeFields) {
						const nextPositions = new Map()
						for (let i = 0; i < frame.ids.length; i++) {
							const id = frame.ids[i]
							const speed = falsifyBridgeField === 'speed' ? 0 : frame.speed[i]
							const previous = previousPositions.get(id)
							if (previous != null) {
								const delta = Math.hypot(
									frame.x[i] - previous[0],
									frame.y[i] - previous[1],
									frame.z[i] - previous[2],
								)
								bridgeMetrics.maxSpeedError = Math.max(
									bridgeMetrics.maxSpeedError,
									Math.abs(speed - delta),
								)
							}
							if (speed > 0) bridgeMetrics.positiveSpeedSamples++
							const flags = falsifyBridgeField === 'firing' ? frame.flags[i] & ~(1 << 5) : frame.flags[i]
							if ((flags & (1 << 5)) !== 0) bridgeMetrics.firingSamples++
							const progress = falsifyBridgeField === 'progress' ? 0 : frame.prodProgress[i]
							bridgeMetrics.maxProduction = Math.max(bridgeMetrics.maxProduction, progress)
							const typeName = typeNames[frame.typeId[i]] ?? ''
							if (/^(foundry_(bellows|flywheel|gale|thermal|updraft)|lattice_(vesper|helix|zephyr))$/.test(typeName)) {
								bridgeMetrics.aircraftSamples++
								const altitude = falsifyBridgeField === 'altitude' ? 0 : frame.z[i]
								bridgeMetrics.maxAircraftZ = Math.max(bridgeMetrics.maxAircraftZ, altitude)
							}
							nextPositions.set(id, [frame.x[i], frame.y[i], frame.z[i]])
						}
						previousPositions = nextPositions

						const events = falsifyBridgeField === 'events' ? [] : frame.events
						bridgeMetrics.eventCount += events.length
						for (const event of events)
							bridgeMetrics.eventKinds[event.kind] = (bridgeMetrics.eventKinds[event.kind] ?? 0) + 1
						if (falsifyBridgeField !== 'projectiles' && frame.projectilesPresent)
							bridgeMetrics.projectileFrames++
						const projectileCount = falsifyBridgeField === 'projectiles'
							? -1
							: frame.projectileCount
						bridgeMetrics.maxProjectileCount = Math.max(
							bridgeMetrics.maxProjectileCount,
							projectileCount,
						)
					}

					for (let i = 0; i < frame.ids.length; i++) {
						const id = frame.ids[i]
						const point = [frame.x[i], frame.y[i], frame.z[i]]
						if (!initial.has(id)) {
							initial.set(id, point)
							if (snapshotCount === 1)
								initialActorIds.add(id)
						}
						latest.set(id, point)
						if (
							snapshotCount > 1 &&
							!initialActorIds.has(id) &&
							frame.owner[i] === 0 &&
							typeNames[frame.typeId[i]]
						)
							builtTypes.add(typeNames[frame.typeId[i]])
						if (
							frame.owner[i] === 1 &&
							commandTypes.has(typeNames[frame.typeId[i]])
						) {
							if (enemyCommand == null || frame.ids[i] < enemyCommand.id)
								enemyCommand = {
									id: frame.ids[i],
									type: typeNames[frame.typeId[i]],
									initialHealth: frame.health[i],
									health: frame.health[i],
									x: frame.x[i],
									y: frame.y[i],
								}
							else if (frame.ids[i] === enemyCommand.id) {
								enemyCommand.health = frame.health[i]
								enemyCommand.x = frame.x[i]
								enemyCommand.y = frame.y[i]
							}
						}
					}

					for (let i = 0; i < pending.length; i++) {
						const order = pending[i]
						if (order == null || probe.tick < order.tick)
							continue

						const human = []
						const enemy = []
						for (let j = 0; j < frame.ids.length; j++) {
							if (frame.owner[j] === 0)
								human.push(j)
							else if (frame.owner[j] === 1)
								enemy.push(j)
						}
						if (human.length === 0)
							throw new Error(`tick ${probe.tick}: no human-owned actors`)

						if (order.subjects === 'mobile-combatants' && subjects.size === 0) {
							const allowedTypes = new Set(order.subjectTypes ?? [])
							for (const j of human) {
								if (allowedTypes.has(typeNames[frame.typeId[j]]))
									subjects.add(frame.ids[j])
							}
							if (subjects.size === 0)
								throw new Error(
									`tick ${probe.tick}: none of the requested mobile-combatant ` +
										`types are present (${[...allowedTypes].join(', ')})`,
								)
						}

						const line = buildOrderLine(
							order,
							frame,
							human,
							enemy,
							subjects,
							terrain,
							typeNames,
						)
						let result
						try {
							result = String(P.RunOrderScriptLine(line))
						} catch (error) {
							throw new Error(
								`tick ${probe.tick} ${order.order} interop threw ` +
									`${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
							)
						}
						if (/^(failed|bad)\b/i.test(result))
							throw new Error(`tick ${probe.tick} ${order.order}: ${result}`)
						actionResults.push({
							tick: probe.tick,
							phase: order.phase,
							order: order.order,
							line,
							result,
						})
						pending[i] = null
					}

					const signature = actorSignature(frame)
					samples.push({
						tick: probe.tick,
						hash: probe.hash,
						signature,
						bridgeSignature: measureBridgeFields ? bridgeFrameSignature(frame) : 0,
					})
					const state = String(P.GetMatchState())
					if (/\bgameover=true\b/.test(state)) {
						const renderPlayers = frame.players.filter(player => (player.flags & (1 << 1)) !== 0)
						const outcomeFlags = renderPlayers[0]?.flags ?? 0
						if ((frame.headerFlags & (1 << 3)) === 0)
							throw new Error('match state is gameover but HeaderFlag.gameOver is clear')
						if (renderPlayers.length !== 1 || ((outcomeFlags & (1 << 3)) === 0) === ((outcomeFlags & (1 << 4)) === 0))
							throw new Error(
								`render-player outcome flags invalid: players=${renderPlayers.length} flags=${outcomeFlags}`,
							)
						bridgeMetrics.outcomeSamples++
						const unexecuted = pending.filter(Boolean)
						if (unexecuted.length > 0 && falsifyBridgeField == null)
							throw new Error(
								`match ended before ${unexecuted.length} script line(s): ` +
									unexecuted.map(order => `${order.phase}/${order.order}@${order.tick}`).join(', '),
							)
						let movedSubjects = 0
						for (const id of subjects) {
							const a = initial.get(id)
							const b = latest.get(id)
							if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) >= 256)
								movedSubjects++
						}
						const expectedProducts = orderScript.orders
							.filter(order =>
								order.order === 'StartProduction' ||
								order.order === 'PlaceBuilding',
							)
							.map(order => order.targetString)
						const missingProducts = expectedProducts.filter(type => !builtTypes.has(type))
						if (missingProducts.length > 0)
							throw new Error(
								`production/placement had no actor-state effect for: ` +
									`${missingProducts.join(', ')}; actions=` +
									actionResults.map(action => `${action.line} -> ${action.result}`).join(' | ') +
									`; match=${state.replaceAll('\n', ' / ')}`,
							)
						return {
							samples,
							state,
							actionResults,
							fullScript: true,
							snapshotCount,
							subjectCount: subjects.size,
							movedSubjects,
							builtTypes: [...builtTypes].sort(),
							tickTimings: globalThis.__s1_simTickTimings.slice(),
							bridgeMetrics,
						}
					}
					if (probe.tick >= tickLimit && measureBridgeFields) {
						const unexecuted = pending.filter(Boolean)
						return {
							samples,
							state,
							actionResults,
							fullScript: unexecuted.length === 0,
							snapshotCount,
							subjectCount: subjects.size,
							movedSubjects: [...subjects].filter(id => {
								const a = initial.get(id)
								const b = latest.get(id)
								return a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) >= 256
							}).length,
							builtTypes: [...builtTypes].sort(),
							tickTimings: globalThis.__s1_simTickTimings.slice(),
							bridgeMetrics,
						}
					}
					if (probe.tick >= tickLimit)
						throw new Error(
							`match did not complete by tick ${tickLimit}: ${state}; ` +
								`enemyCommand=${JSON.stringify(enemyCommand)}; ` +
								`subjects=${[...subjects].map(id => {
									const point = latest.get(id)
									return `${id}@${point?.[0] ?? '-'},${point?.[1] ?? '-'}`
								}).join(',')}; actions=` +
								actionResults.map(action => `${action.line} -> ${action.result}`).join(' | '),
						)
					await nextFrame()
				}
				throw new Error(`timed out after ${deadlineMs}ms`)

				function decodeFrame(memory) {
					const bytes = memory instanceof Uint8Array ? memory : new Uint8Array(memory)
					const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
					if (view.getUint32(0, true) !== 0x504e5353)
						throw new Error('bad snapshot magic')
					const sectionCount = view.getUint16(6, true)
					const tick = view.getUint32(12, true)
					const headerFlags = view.getUint32(24, true)
					let worldOff = -1
					let terrainOff = -1
					let actorOff = -1
					let projectileOff = -1
					let eventOff = -1
					let eventLength = 0
					let playerOff = -1
					for (let i = 0; i < sectionCount; i++) {
						const e = 32 + i * 12
						const id = view.getUint16(e, true)
						if (id === 0)
							worldOff = view.getUint32(e + 4, true)
						else if (id === 1)
							terrainOff = view.getUint32(e + 4, true)
						else if (id === 3)
							actorOff = view.getUint32(e + 4, true)
						else if (id === 5)
							projectileOff = view.getUint32(e + 4, true)
						else if (id === 7) {
							eventOff = view.getUint32(e + 4, true)
							eventLength = view.getUint32(e + 8, true)
						} else if (id === 8)
							playerOff = view.getUint32(e + 4, true)
					}
					if (worldOff < 0 || actorOff < 0)
						throw new Error('snapshot lacks world or actors section')
					const bounds = [
						view.getInt32(worldOff, true),
						view.getInt32(worldOff + 4, true),
						view.getInt32(worldOff + 8, true),
						view.getInt32(worldOff + 12, true),
					]
					let terrain = null
					if (terrainOff >= 0) {
						const width = view.getUint32(terrainOff, true)
						const height = view.getUint32(terrainOff + 4, true)
						const count = width * height
						let tp = terrainOff + 8
						const planes = []
						for (let plane = 0; plane < 6; plane++) {
							planes.push(bytes.slice(tp, tp + count))
							tp = (tp + count + 3) & ~3
						}
						terrain = {
							width,
							height,
							ramp: planes[2],
							passability: planes[3],
							resource: planes[4],
						}
					}
					const n = view.getUint32(actorOff, true)
					let p = actorOff + 8
					const ids = []
					const x = []
					const y = []
					const z = []
					for (let i = 0; i < n; i++, p += 4) ids.push(view.getUint32(p, true))
					for (let i = 0; i < n; i++, p += 4) x.push(view.getInt32(p, true))
					for (let i = 0; i < n; i++, p += 4) y.push(view.getInt32(p, true))
					for (let i = 0; i < n; i++, p += 4) z.push(view.getInt32(p, true))
					const typeId = []
					const prodProgress = []
					const speed = []
					for (let i = 0; i < n; i++, p += 2) typeId.push(view.getUint16(p, true))
					p += n * 2 * 2
					for (let i = 0; i < n; i++, p += 2)
						prodProgress.push(view.getUint16(p, true))
					p += n * 2
					for (let i = 0; i < n; i++, p += 2) speed.push(view.getUint16(p, true))
					p = (p + 3) & ~3
					const owner = []
					const health = []
					const flags = []
					for (let i = 0; i < n; i++) owner.push(view.getUint8(p + i))
					p += n
					for (let i = 0; i < n; i++) health.push(view.getUint8(p + i))
					p += n * 3
					for (let i = 0; i < n; i++) flags.push(view.getUint8(p + i))

					const events = []
					let eventHash = 2166136261
					if (eventOff >= 0) {
						const eventCount = view.getUint32(eventOff, true)
						let ep = eventOff + 4
						const eventEnd = eventOff + eventLength
						for (let i = 0; i < eventCount; i++) {
							if (ep + 4 > eventEnd) throw new Error(`event ${i} header exceeds section`)
							const kind = view.getUint16(ep, true)
							const byteLength = view.getUint16(ep + 2, true)
							if (ep + 4 + byteLength > eventEnd)
								throw new Error(`event ${i} payload exceeds section`)
							events.push({ kind, byteLength })
							ep = (ep + 4 + byteLength + 3) & ~3
						}
						for (let i = eventOff; i < eventOff + eventLength; i++) {
							eventHash ^= bytes[i]
							eventHash = Math.imul(eventHash, 16777619)
						}
					}
					const players = []
					if (playerOff >= 0) {
						const playerCount = view.getUint32(playerOff, true)
						let pp = playerOff + 4
						for (let i = 0; i < playerCount; i++) {
							const queueCount = view.getUint16(pp + 16, true)
							let playerFlags = view.getUint8(pp + 15)
							if (falsifyBridgeField === 'outcome') playerFlags &= ~((1 << 3) | (1 << 4))
							players.push({ id: view.getUint8(pp + 12), flags: playerFlags })
							pp += 22 + queueCount * 8
						}
					}
					return {
						tick,
						headerFlags,
						bounds,
						terrain,
						ids,
						x,
						y,
						z,
						typeId,
						prodProgress,
						speed,
						owner,
						health,
						flags,
						projectilesPresent: projectileOff >= 0,
						projectileCount: projectileOff < 0 ? -1 : view.getUint32(projectileOff, true),
						events,
						players,
						eventHash: eventHash >>> 0,
					}
				}

				function validateFrame(frame, expectedTick) {
					if (frame.tick !== expectedTick)
						throw new Error(`snapshot tick ${frame.tick} != probe tick ${expectedTick}`)
					for (let i = 0; i < frame.ids.length; i++) {
						if (i > 0 && frame.ids[i] <= frame.ids[i - 1])
							throw new Error(`actor ids not strictly sorted at ${i}`)
						if (
							!Number.isFinite(frame.x[i]) ||
							!Number.isFinite(frame.y[i]) ||
							!Number.isFinite(frame.z[i])
						)
							throw new Error(`non-finite actor position for id ${frame.ids[i]}`)
					}
				}

				function actorSignature(frame) {
					let h = 2166136261
					const mix = value => {
						h ^= value >>> 0
						h = Math.imul(h, 16777619)
					}
					for (let i = 0; i < frame.ids.length; i++) {
						mix(frame.ids[i])
						mix(frame.x[i])
						mix(frame.y[i])
						mix(frame.z[i])
						mix(frame.typeId[i])
						mix(frame.prodProgress[i])
						mix(frame.owner[i])
						mix(frame.health[i])
					}
					return h >>> 0
				}

				function bridgeFrameSignature(frame) {
					let h = 2166136261
					const mix = value => {
						h ^= value >>> 0
						h = Math.imul(h, 16777619)
					}
					for (let i = 0; i < frame.ids.length; i++) {
						mix(frame.ids[i])
						mix(frame.speed[i])
						mix(frame.flags[i])
						mix(frame.prodProgress[i])
						mix(frame.z[i])
					}
					mix(frame.projectilesPresent ? 1 : 0)
					mix(frame.projectileCount)
					mix(frame.eventHash)
					mix(frame.headerFlags)
					for (const player of frame.players) {
						mix(player.id)
						mix(player.flags)
					}
					return h >>> 0
				}

				function buildOrderLine(
					order,
					frame,
					human,
					enemy,
					chosenSubjects,
					staticTerrain,
					typeNames,
				) {
					if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(order.order))
						throw new Error(`unsafe order name '${order.order}'`)
					const tokens = ['order', order.order]
					if (order.subjects === 'mobile-combatants') {
						const live = [...chosenSubjects].filter(id => frame.ids.includes(id))
						if (live.length === 0)
							throw new Error(`tick ${frame.tick}: no live mobile-combatants`)
						tokens.push(`subject=${live.join(',')}`)
					}

					let cell = null
					let targetActorId = order.targetActorId ?? null
					if (order.target === 'enemy-centroid') {
						if (enemy.length === 0)
							throw new Error(`tick ${frame.tick}: no enemy target`)
						cell = centroidCell(frame, enemy)
					} else if (order.target === 'map-centre')
						cell = [
							Math.floor((frame.bounds[0] + frame.bounds[2]) / 2),
							Math.floor((frame.bounds[1] + frame.bounds[3]) / 2),
						]
					else if (order.target === 'near-spawn') {
						if (staticTerrain == null)
							throw new Error('terrain.static unavailable for building placement')
						cell = findBuildCell(
							frame,
							human,
							staticTerrain,
							order.footprint ?? [1, 1],
							reservedBuildCells,
						)
					} else if (order.target === 'enemy-command') {
						const targetTypes = new Set(order.targetTypes ?? [])
						const targetIndex = enemy
							.filter(index => targetTypes.has(typeNames[frame.typeId[index]]))
							.sort((a, b) => frame.ids[a] - frame.ids[b])[0]
						if (targetIndex == null)
							throw new Error(
								`tick ${frame.tick}: no enemy command actor of type ` +
									`${[...targetTypes].join(', ')}`,
							)
						targetActorId = frame.ids[targetIndex]
					}
					if (cell != null)
						tokens.push(`cell=${cell[0]},${cell[1]}`)
					if (targetActorId != null)
						tokens.push(`actor=${integerToken(targetActorId, 'targetActorId')}`)
					if (order.targetString != null) {
						if (!/^[A-Za-z0-9_.:-]+$/.test(order.targetString))
							throw new Error(`unsafe target string '${order.targetString}'`)
						tokens.push(`str=${order.targetString}`)
					}
					if (order.extraData != null)
						tokens.push(`n=${integerToken(order.extraData, 'extraData')}`)
					if (order.queued)
						tokens.push('queued')
					return tokens.join(' ')
				}

				function centroidCell(frame, indices) {
					let x = 0
					let y = 0
					for (const i of indices) {
						x += frame.x[i]
						y += frame.y[i]
					}
					return [
						Math.floor(x / indices.length / 1024),
						Math.floor(y / indices.length / 1024),
					]
				}

				function findBuildCell(frame, human, staticTerrain, footprint, reserved) {
					if (
						!Array.isArray(footprint) ||
						footprint.length !== 2 ||
						!footprint.every(Number.isSafeInteger)
					)
						throw new Error('building footprint must be [width,height] integers')
					const [footprintWidth, footprintHeight] = footprint
					const home = centroidCell(frame, human)
					const centre = [
						(frame.bounds[0] + frame.bounds[2]) / 2,
						(frame.bounds[1] + frame.bounds[3]) / 2,
					]
					const preferred = [
						home[0] + Math.sign(centre[0] - home[0]) * 5,
						home[1] + Math.sign(centre[1] - home[1]) * 5,
					]
					const occupied = new Set()
					for (let i = 0; i < frame.ids.length; i++)
						occupied.add(`${Math.floor(frame.x[i] / 1024)},${Math.floor(frame.y[i] / 1024)}`)
					for (const cell of reserved) occupied.add(cell)

					const candidates = []
					for (let y = frame.bounds[1]; y <= frame.bounds[3] - footprintHeight; y++) {
						for (let x = frame.bounds[0]; x <= frame.bounds[2] - footprintWidth; x++) {
							const dx = x - preferred[0]
							const dy = y - preferred[1]
							candidates.push([dx * dx + dy * dy, y, x])
						}
					}
					candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
					for (const [, y, x] of candidates) {
						let valid = true
						for (let fy = 0; fy < footprintHeight && valid; fy++) {
							for (let fx = 0; fx < footprintWidth; fx++) {
								const cellX = x + fx
								const cellY = y + fy
								const index =
									(cellY - frame.bounds[1]) * staticTerrain.width +
									cellX - frame.bounds[0]
								const passability = staticTerrain.passability[index]
								if (
									index < 0 ||
									index >= staticTerrain.width * staticTerrain.height ||
									staticTerrain.ramp[index] !== 0 ||
									(passability & (1 << 4)) !== 0 ||
									(passability & (1 << 0)) === 0 ||
									staticTerrain.resource[index] !== 0 ||
									occupied.has(`${cellX},${cellY}`)
								) {
									valid = false
									break
								}
							}
						}
						if (valid) {
							for (let fy = 0; fy < footprintHeight; fy++)
								for (let fx = 0; fx < footprintWidth; fx++)
									reserved.add(`${x + fx},${y + fy}`)
							return [x, y]
						}
					}
					throw new Error(
						`no buildable ${footprintWidth}x${footprintHeight} footprint near spawn; ` +
							`passability=${histogram(staticTerrain.passability)} ` +
							`ramps=${histogram(staticTerrain.ramp)} ` +
							`resources=${histogram(staticTerrain.resource)}`,
					)
				}

				function histogram(values) {
					const counts = new Map()
					for (const value of values)
						counts.set(value, (counts.get(value) ?? 0) + 1)
					return [...counts]
						.sort((a, b) => a[0] - b[0])
						.map(([value, count]) => `${value}:${count}`)
						.join(',')
				}

				function integerToken(value, name) {
					if (!Number.isSafeInteger(value))
						throw new Error(`${name} must be an integer`)
					return value
				}
			},
			{
				orderScript: script,
				tickLimit: bridgeStopTick,
				deadlineMs: timeoutMs,
				measureBridgeFields: bridgeFields,
				falsifyBridgeField: bridgeFalsify,
			},
		)

		if (errors.length > 0)
			throw new Error(`${label}: ${errors[0]}`)
		if (!bridgeFields && !/\bgameover=true\b/.test(capture.state))
			throw new Error(`${label}: match was not decided: ${capture.state}`)
		if (!bridgeFields && !/\|(Won|Lost)\|/.test(capture.state))
			throw new Error(`${label}: no player has a decided win state`)
		if (!capture.fullScript && (!bridgeFields || bridgeOnly == null))
			throw new Error(`${label}: text order-script did not complete`)
		if (capture.movedSubjects === 0 && (!bridgeFields || bridgeOnly !== 'projectiles'))
			throw new Error(`${label}: scripted subjects never moved (stuck pathing)`)
		console.log(
			`playtest: ${label} completed at ${capture.state.split('\n')[0]}, ` +
				`${capture.samples.length} samples, ${capture.actionResults.length} script lines, ` +
				formatTimings(capture.tickTimings),
		)
		return capture
	} finally {
		await context.close()
	}
}

function firstDivergence(a, b) {
	const length = Math.max(a.length, b.length)
	for (let i = 0; i < length; i++) {
		const x = a[i]
		const y = b[i]
		if (
			x == null ||
			y == null ||
			x.tick !== y.tick ||
			x.hash !== y.hash ||
			x.signature !== y.signature ||
			x.bridgeSignature !== y.bridgeSignature
		)
			return {
				tick: x?.tick ?? y?.tick ?? i,
				a: x ? `${hex(x.hash)}/${hex(x.signature)}/${hex(x.bridgeSignature)}` : null,
				b: y ? `${hex(y.hash)}/${hex(y.signature)}/${hex(y.bridgeSignature)}` : null,
			}
	}
	return null
}

function assertBridgeFields(metrics, only) {
	const wants = field => only == null || only === field
	if (wants('speed')) {
		if (metrics.positiveSpeedSamples === 0)
			throw new Error('bridge speed witness red: no positive speed sample')
		if (metrics.maxSpeedError > 1)
			throw new Error(
				`bridge speed witness red: max |speed-Δpos| ${metrics.maxSpeedError.toFixed(3)} WDist > 1`,
			)
	}
	if (wants('firing') && metrics.firingSamples === 0)
		throw new Error('bridge firing witness red: ActorFlag.Firing was never set')
	if (wants('progress') && metrics.maxProduction <= 0)
		throw new Error('bridge progress witness red: prodProgress never exceeded zero')
	if (wants('altitude')) {
		if (metrics.aircraftSamples === 0)
			throw new Error('bridge altitude prerequisite red: no aircraft actor was observed')
		if (metrics.maxAircraftZ <= 0)
			throw new Error('bridge altitude witness red: observed aircraft never emitted positive posZ')
	}
	if (wants('events')) {
		for (const kind of [1, 2, 4])
			if ((metrics.eventKinds[kind] ?? 0) === 0)
				throw new Error(`bridge events witness red: event kind ${kind} never emitted`)
	}
	if (wants('projectiles')) {
		if (metrics.projectileFrames === 0)
			throw new Error('bridge projectiles witness red: section was always absent')
		if (metrics.maxProjectileCount !== 0)
			throw new Error(
				`bridge projectiles witness red: InstantHit roster reported count ${metrics.maxProjectileCount}`,
			)
	}
	if (wants('outcome') && metrics.outcomeSamples === 0)
		throw new Error('bridge outcome witness red: no authoritative render-player outcome sample')
}

function assertRequiredBuiltTypes(capture, only) {
	if (!bridgeFields) return
	for (const [field, types] of Object.entries(script.requiredBuiltTypes ?? {})) {
		if (only != null && only !== field) continue
		const missing = types.filter(type => !capture.builtTypes.includes(type))
		if (missing.length > 0)
			throw new Error(
				`bridge ${field} prerequisite red: required scripted subject(s) never built: ` +
				missing.join(', '),
			)
	}
}

function formatEventKinds(kinds) {
	return Object.entries(kinds)
		.sort((a, b) => Number(a[0]) - Number(b[0]))
		.map(([kind, count]) => `${kind}:${count}`)
		.join(', ')
}

function validateScript(value) {
	if (value?.schema !== 1 || !value.scenario || !Array.isArray(value.orders))
		throw new Error('playtest: order script must have schema=1, scenario and orders[]')
	let lastTick = -1
	const phases = new Set()
	for (const order of value.orders) {
		if (!Number.isSafeInteger(order.tick) || order.tick < 0)
			throw new Error('playtest: every order tick must be a non-negative integer')
		if (order.tick < lastTick)
			throw new Error('playtest: orders must be sorted by tick')
		if (typeof order.order !== 'string' || typeof order.phase !== 'string')
			throw new Error('playtest: every order needs order and phase strings')
		if (
			order.subjects === 'mobile-combatants' &&
			(!Array.isArray(order.subjectTypes) || order.subjectTypes.length === 0)
		)
			throw new Error('playtest: mobile-combatants orders need subjectTypes[]')
		lastTick = order.tick
		phases.add(order.phase)
	}
	for (const phase of ['build', 'expand', 'engage', 'defend', 'win'])
		if (!phases.has(phase))
			throw new Error(`playtest: text script lacks required '${phase}' phase`)
	for (const [field, types] of Object.entries(value.requiredBuiltTypes ?? {})) {
		if (!bridgeFieldNames.has(field) || !Array.isArray(types) || types.length === 0)
			throw new Error(`playtest: invalid requiredBuiltTypes entry '${field}'`)
		for (const type of types) {
			if (typeof type !== 'string' || type.length === 0)
				throw new Error(`playtest: requiredBuiltTypes.${field} needs actor type strings`)
			if (!value.orders.some(order =>
				order.order === 'StartProduction' && order.targetString === type,
			))
				throw new Error(
					`playtest: required built type '${type}' has no StartProduction order`,
				)
		}
	}
}

function parseFlags(args) {
	const valueFlags = new Set(['script', 'max-ticks', 'port', 'url', 'timeout-ms', 'only', 'falsify'])
	const flags = new Map()
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!arg.startsWith('--'))
			throw new Error(`playtest: unknown positional argument '${arg}'`)
		const body = arg.slice(2)
		const eq = body.indexOf('=')
		const name = eq < 0 ? body : body.slice(0, eq)
		if (valueFlags.has(name)) {
			const v = eq < 0 ? args[++i] : body.slice(eq + 1)
			if (v == null || v === '')
				throw new Error(`playtest: --${name} requires a value`)
			flags.set(name, v)
		} else if (name === 'keep-server' || name === 'bridge-fields')
			flags.set(name, true)
		else
			throw new Error(`playtest: unknown flag --${name}`)
	}
	return flags
}

async function launchBrowser() {
	try {
		return await chromium.launch({ headless: true })
	} catch (error) {
		if (!/Executable doesn't exist|please run|install/i.test(String(error.message)))
			throw error
		console.log('playtest: bundled Chromium absent; using installed Chrome')
		return chromium.launch({ headless: true, channel: 'chrome' })
	}
}

async function waitForServer(url, timeoutMs, child) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null)
			throw new Error(`playtest: static server exited early with code ${child.exitCode}`)
		try {
			const response = await fetch(url, {
				method: 'GET',
				cache: 'no-store',
				signal: AbortSignal.timeout(1000),
			})
			await response.body?.cancel()
			if (response.ok)
				return
		} catch {
			// Server is still starting.
		}
		await new Promise(resolveWait => setTimeout(resolveWait, 100))
	}
	throw new Error(`playtest: server did not start at ${url} within ${timeoutMs}ms`)
}

function positiveInteger(value, name) {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`playtest: --${name} must be a positive integer`)
	return parsed
}

function hex(value) {
	return `0x${value.toString(16).padStart(8, '0')}`
}

function formatTimings(values) {
	if (!Array.isArray(values) || values.length === 0)
		return 'timing unavailable'
	const sorted = [...values].sort((a, b) => a - b)
	const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
	return `${values.length} ticks p50=${percentile(0.5).toFixed(3)}ms ` +
		`p95=${percentile(0.95).toFixed(3)}ms p99=${percentile(0.99).toFixed(3)}ms`
}
