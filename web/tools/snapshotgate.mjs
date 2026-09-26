#!/usr/bin/env node
// STEELSEED — tools/snapshotgate
// Cross-language layout gate for the live C# PollSnapshot -> JS SnapshotDecoder boundary.
//
// This tool proves that every byte in each PRESENT live-host snapshot is claimed exactly once
// by the v2 header/table/sections, and that every present section's declared byte length matches
// an independent calculation from ARCHITECTURE.md §4. It does NOT prove that a decoded value is
// equal to the C# variable it came from, and it cannot exercise a section the live emitter does
// not publish. Those are value-parity and fixture-coverage questions, not layout round-trips.
//
// Negative controls:
//   --falsify trailing-byte   append one byte without changing the encoded header/table
//   --falsify section-length shrink world.len by 4 without changing its payload
//
// The current decoder accepts both mutations. That is intentional evidence for why this gate
// must validate whole-buffer coverage and independent section lengths in addition to decoding.

import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { SnapshotDecoder } from '../src/core/snapshot.ts'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

// Duplicated deliberately from ARCHITECTURE.md §4, not imported from snapshot.ts.
// This gate must not inherit the decoder arithmetic it is checking.
const V1_MAGIC = 0x504e5353
const V1_VERSION = 2
const V1_HEADER_BYTES = 32
const V1_SECTION_ENTRY_BYTES = 12
const V1_SECTIONS = Object.freeze({
	world: 0,
	terrainStatic: 1,
	terrainDelta: 2,
	actors: 3,
	lifecycle: 4,
	projectiles: 5,
	shroud: 6,
	events: 7,
	player: 8,
	production: 9,
	frozenActors: 10,
	resources: 11,
	deployments: 12,
	actorStatus: 13,
})
const SECTION_NAMES = Object.freeze([
	'world',
	'terrain.static',
	'terrain.delta',
	'actors',
	'actors.lifecycle',
	'projectiles',
	'shroud',
	'events',
	'player',
	'production',
	'frozen actors',
	'resources',
	'deployments',
	'actors.status',
])
// The first live PollSnapshot is the fixture: current SnapshotEmitter emits these eight
// sections, including the once-at-map-load terrain.static payload.
const LIVE_FIXTURE_SECTIONS = Object.freeze([
	V1_SECTIONS.world,
	V1_SECTIONS.terrainStatic,
	V1_SECTIONS.actors,
	V1_SECTIONS.lifecycle,
	V1_SECTIONS.shroud,
	V1_SECTIONS.events,
	V1_SECTIONS.player,
	V1_SECTIONS.production,
	V1_SECTIONS.frozenActors,
	V1_SECTIONS.resources,
	V1_SECTIONS.deployments,
	V1_SECTIONS.actorStatus,
])

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME_ROOT = resolve(WEB_ROOT, '..')
const ENGINE_ROOT = join(GAME_ROOT, 'engine')
const APP_BUNDLE = join(ENGINE_ROOT, 'bin-browser', 'AppBundle')
const SERVER_SCRIPT = join(ENGINE_ROOT, 'OpenRA.Browser', 'tests', 'server.mjs')

const VALUE_FLAGS = new Set(['seed', 'port', 'url', 'timeout-ms', 'falsify'])
const BOOLEAN_FLAGS = new Set(['keep-server', 'probe-decoder-controls', 'moving'])
const flags = parseFlags(process.argv.slice(2))
const flag = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const seed = unsignedInteger(flag('seed', 104729), 'seed')
const port = positiveInteger(flag('port', 8384), 'port')
const timeoutMs = positiveInteger(flag('timeout-ms', 120000), 'timeout-ms')
const falsify = flag('falsify', 'none')
if (!['none', 'trailing-byte', 'section-length'].includes(falsify))
	throw new Error(`snapshotgate: unknown falsifier '${falsify}'`)

const scenario = Object.freeze({
	generatorType: 'seedline',
	optionId: 'Preset',
	presetChoice: 'amber-crossing',
	tileset: 'STEELWORKS',
	botCount: 1,
	botType: 'normal',
})

let chromium
try {
	;({ chromium } = await import('playwright'))
} catch {
	console.error(
		'snapshotgate: playwright is not installed.\n' +
			'  cd web && npm install && npx playwright install chromium',
	)
	process.exit(2)
}

if (flags.has('moving')) {
	const movingExitCode = await runMovingFixtureGate()
	process.exit(movingExitCode)
}

const suppliedUrl = flag('url', null)
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
	const liveBytes = await captureLiveSnapshot(browser)

	if (flags.has('probe-decoder-controls')) {
		const variants = [
			['live', liveBytes],
			['trailing-byte', appendTrailingByte(liveBytes)],
			['section-length', shrinkWorldSection(liveBytes).buffer],
		]
		const results = variants.map(([name, bytes]) => ({
			name,
			bytes: bytes.byteLength,
			decoder: decoderAcceptance(bytes),
		}))
		console.log(JSON.stringify({ mode: 'decoder-control-probe', results }, null, 2))
		if (results.some(result => !result.decoder.accepted))
			throw new Error('a pre-assertion decoder control was rejected; inspect the report')
	} else {
		const mutation = falsify === 'trailing-byte'
			? { buffer: appendTrailingByte(liveBytes), detail: 'appended one sentinel byte' }
			: falsify === 'section-length'
				? shrinkWorldSection(liveBytes)
				: { buffer: liveBytes, detail: 'unmodified live snapshot' }

		const result = validateSnapshotLayout(mutation.buffer)
		printValidationResult(result, mutation.detail)
		if (result.failures.length > 0)
			exitCode = 1
	}
} catch (error) {
	console.error(`snapshotgate: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null)
		await browser.close()
	if (server != null && !flags.has('keep-server'))
		await stopProcessGroup(server)
}

process.exit(exitCode)

async function runMovingFixtureGate() {
	const suppliedMovingUrl = flag('url', null)
	const movingUrl = suppliedMovingUrl ?? `http://127.0.0.1:${port}/`
	let movingServer = null
	let movingBrowser = null
	let movingExitCode = 0

	try {
		if (suppliedMovingUrl == null) {
			movingServer = spawnProcessGroup('npx', [
				'vite',
				'--host', '127.0.0.1',
				'--port', String(port),
				'--strictPort',
			], {
				cwd: WEB_ROOT,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			await waitForServer(movingUrl, 30000, movingServer)
		}

		movingBrowser = await launchBrowser()
		const context = await movingBrowser.newContext({
			viewport: { width: 960, height: 540 },
			deviceScaleFactor: 1,
			locale: 'en-US',
			timezoneId: 'UTC',
		})
		const page = await context.newPage()
		const pageErrors = []
		page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`))
		// Load core + the dev bridge in a minimal same-origin harness. Booting the shipping
		// index would prewarm all 97 meshes before this core-contract gate could begin and,
		// worse, would make a snapshot assertion depend on unrelated asset construction.
		// The real App pump/decoder/ctx seam is still exercised; only optional systems are absent.
		const harnessPath = '/__snapshotgate_moving__.html'
		await page.route(`**${harnessPath}`, route => route.fulfill({
			contentType: 'text/html',
			body: `<!doctype html><canvas id="fixture" width="960" height="540"></canvas>
				<script type="module">
					try {
						const [{ App }, { buildDevSnapshotAt, createDevBridge }] = await Promise.all([
							import('/src/core/app.ts'),
							import('/src/core/devsnapshot.ts'),
						])
						const fixtureOpts = { seed: ${JSON.stringify(String(seed))} }
						const bytesA = new Uint8Array(buildDevSnapshotAt(73, fixtureOpts))
						const bytesB = new Uint8Array(buildDevSnapshotAt(73, fixtureOpts))
						globalThis.__movingByteIdentity = {
							byteLength: bytesA.byteLength,
							equal: bytesA.byteLength === bytesB.byteLength && bytesA.every((value, i) => value === bytesB[i]),
						}
						globalThis.__movingApp = await App.boot({
							canvas: document.getElementById('fixture'),
							systems: [],
							bridge: createDevBridge(fixtureOpts),
							deterministic: true,
						})
						globalThis.__movingReady = { ok: true }
					} catch (error) {
						globalThis.__movingReady = { ok: false, error: String(error?.stack ?? error) }
					}
				</script>`,
		}))

		const url = new URL(harnessPath, movingUrl)
		await page.goto(url.href, { waitUntil: 'load', timeout: 60000 })
		await page.waitForFunction(() => globalThis.__movingReady !== undefined, undefined, { timeout: timeoutMs })
		const ready = await page.evaluate(() => globalThis.__movingReady)
		if (!ready.ok) throw new Error(ready.error)

		const report = await page.evaluate(() => {
			const app = globalThis.__movingApp
			const failures = []
			const byteIdentity = globalThis.__movingByteIdentity
			if (!byteIdentity?.equal)
				failures.push('buildDevSnapshotAt(73) differed across two calls with identical options')
			let comparisons = 0
			let maxSpeedErrorWDist = 0
			let maxFacingErrorWAngle = 0
			let prevNonNullFromFrame = null
			let aircraftMinPosZ = Infinity
			let aircraftMaxPosZ = -Infinity
			let rampMinPosZ = Infinity
			let rampMaxPosZ = -Infinity
			let rampCrossSlopeSteps = 0
			let columnMinSpeed = Infinity
			let columnMaxSpeed = -Infinity
			let turretDivergenceSamples = 0
			let turretSweepChanges = 0
			const lastTurretFacing = new Array(6).fill(null)
			let infantryMovingSamples = 0
			let terrainStaticPublications = 0
			let terrainStaticSectionPublications = 0
			let terrainFixture = null

			for (let frame = 0; frame <= 100; frame++) {
				app.renderOneFrame(frame * 40)
				const current = app.ctx.snapshot
				const previous = app.ctx.prevSnapshot
				if (current == null || current.actors == null) {
					failures.push(`frame ${frame + 1}: current snapshot/actors is null`)
					continue
				}
				if (previous != null && prevNonNullFromFrame == null)
					prevNonNullFromFrame = frame + 1
				if (frame >= 1 && previous == null)
					failures.push(`frame ${frame + 1}: prevSnapshot is null`)
				if (current.tick !== frame)
					failures.push(`frame ${frame + 1}: tick ${current.tick}, expected ${frame}`)
				const terrainFlag = (current.flags & (1 << 0)) !== 0
				const terrainSection = current.sections.has(1)
				if (terrainFlag) terrainStaticPublications++
				if (terrainSection) terrainStaticSectionPublications++
				if (terrainFlag !== terrainSection)
					failures.push(`frame ${frame + 1}: terrain.static flag=${terrainFlag} section=${terrainSection}`)
				if (terrainSection) terrainFixture = current.terrainStatic

				const actors = current.actors
				if (actors.count > 6) {
					aircraftMinPosZ = Math.min(aircraftMinPosZ, actors.posZ[6])
					aircraftMaxPosZ = Math.max(aircraftMaxPosZ, actors.posZ[6])
				}
				if (actors.count > 5) {
					rampMinPosZ = Math.min(rampMinPosZ, actors.posZ[5])
					rampMaxPosZ = Math.max(rampMaxPosZ, actors.posZ[5])
					if (terrainFixture != null) {
						const terrain = terrainFixture
						const x = Math.floor(actors.posX[5] / 1024) - current.world.boundsLeft
						const y = Math.floor(actors.posY[5] / 1024) - current.world.boundsTop
						if (x >= 0 && x < terrain.w && y > 0 && y + 1 < terrain.h)
							rampCrossSlopeSteps = Math.max(
								rampCrossSlopeSteps,
								Math.abs(terrain.height[(y + 1) * terrain.w + x] - terrain.height[(y - 1) * terrain.w + x]),
							)
					}
				}
				if (actors.count > 7 && actors.speed[7] > 0 && (actors.flags[7] & (1 << 6)) !== 0)
					infantryMovingSamples++
				for (let actor = 0; actor < Math.min(5, actors.count); actor++) {
					columnMinSpeed = Math.min(columnMinSpeed, actors.speed[actor])
					columnMaxSpeed = Math.max(columnMaxSpeed, actors.speed[actor])
				}

				for (let actor = 0; actor < Math.min(6, actors.count); actor++) {
					if (actors.turretCount[actor] !== 1) {
						failures.push(`frame ${frame + 1} actor ${actor + 1}: turretCount ${actors.turretCount[actor]}, expected 1`)
						continue
					}
					const turretFacing = actors.turretFacing[actors.turretOffset[actor]]
					if (turretFacing !== actors.facing[actor]) turretDivergenceSamples++
					if (lastTurretFacing[actor] != null && turretFacing !== lastTurretFacing[actor])
						turretSweepChanges++
					lastTurretFacing[actor] = turretFacing
				}

				if (previous?.actors == null) continue
				for (let actor = 0; actor < actors.count; actor++) {
					if ((actors.flags[actor] & (1 << 6)) === 0) continue
					const prior = previous.actors
					const dx = actors.posX[actor] - prior.posX[actor]
					const dy = actors.posY[actor] - prior.posY[actor]
					const dz = actors.posZ[actor] - prior.posZ[actor]
					const measured = Math.round(Math.hypot(dx, dy, dz))
					const error = Math.abs(actors.speed[actor] - measured)
					maxSpeedErrorWDist = Math.max(maxSpeedErrorWDist, error)
					const expectedFacing = ((Math.round(Math.atan2(-dx, -dy) * 1024 / (Math.PI * 2)) % 1024) + 1024) % 1024
					const facingDelta = Math.abs(actors.facing[actor] - expectedFacing)
					const facingError = Math.min(facingDelta, 1024 - facingDelta)
					maxFacingErrorWAngle = Math.max(maxFacingErrorWAngle, facingError)
					comparisons++
					if (error > 1)
						failures.push(`tick ${current.tick} actor ${actor + 1}: speed ${actors.speed[actor]} vs delta ${measured} WDist`)
					if (facingError > 1)
						failures.push(`tick ${current.tick} actor ${actor + 1}: facing ${actors.facing[actor]} vs tangent ${expectedFacing}`)
					if ((actors.flags[actor] & (1 << 6)) === 0)
						failures.push(`tick ${current.tick} actor ${actor + 1}: non-zero speed without moving flag`)
				}
			}

			if (prevNonNullFromFrame !== 2)
				failures.push(`prevSnapshot first became non-null on frame ${prevNonNullFromFrame}, expected frame 2`)
			if (!(aircraftMinPosZ > 0 && aircraftMaxPosZ > aircraftMinPosZ))
				failures.push(`aircraft posZ range ${aircraftMinPosZ}..${aircraftMaxPosZ} does not exercise a climbing orbit`)
			if (!(rampMaxPosZ > rampMinPosZ))
				failures.push(`ramp actor posZ range ${rampMinPosZ}..${rampMaxPosZ} has no pitch signal`)
			if (rampCrossSlopeSteps < 1)
				failures.push(`ramp cross-slope is ${rampCrossSlopeSteps} height steps; roll signal is absent`)
			if (columnMaxSpeed - columnMinSpeed > 2)
				failures.push(`tracked column speed range ${columnMinSpeed}..${columnMaxSpeed} exceeds 2 WDist of integer quantisation`)
			if (turretDivergenceSamples !== 101 * 6)
				failures.push(`turret/hull divergence ${turretDivergenceSamples}/606 samples`)
			if (turretSweepChanges !== 100 * 6)
				failures.push(`turret sweep changed ${turretSweepChanges}/600 transitions`)
			if (infantryMovingSamples !== 101)
				failures.push(`infantry moving signal ${infantryMovingSamples}/101 samples`)
			if (terrainStaticPublications !== 1)
				failures.push(`terrain.static flag published ${terrainStaticPublications} times, expected exactly 1`)
			if (terrainStaticSectionPublications !== 1)
				failures.push(`terrain.static section published ${terrainStaticSectionPublications} times, expected exactly 1`)

			return {
				frames: 101,
				byteIdentity,
				transitions: 100,
				comparisons,
				maxSpeedErrorWDist,
				maxFacingErrorWAngle,
				prevNonNullFromFrame,
				aircraftPosZRange: [aircraftMinPosZ, aircraftMaxPosZ],
				rampPosZRange: [rampMinPosZ, rampMaxPosZ],
				rampCrossSlopeSteps,
				columnSpeedRange: [columnMinSpeed, columnMaxSpeed],
				turretDivergenceSamples,
				turretSweepChanges,
				infantryMovingSamples,
				terrainStaticPublications,
				terrainStaticSectionPublications,
				failures,
			}
		})

		for (const pageError of pageErrors) report.failures.push(pageError)
		const status = report.failures.length === 0 ? 'PASS' : 'FAIL'
		console.log(
			`snapshotgate: ${status} --moving — ${report.frames} frames / ${report.transitions} transitions; ` +
			`tick-73 byte identity ${report.byteIdentity?.equal ? `${report.byteIdentity.byteLength}B` : 'FAILED'}; ` +
			`${report.comparisons} moving-actor deltas; max speed error ${report.maxSpeedErrorWDist} WDist; ` +
			`max facing error ${report.maxFacingErrorWAngle} WAngle; column speed ${report.columnSpeedRange[0]}..${report.columnSpeedRange[1]}; ` +
			`prevSnapshot non-null from frame ${report.prevNonNullFromFrame}; aircraft posZ ` +
			`${report.aircraftPosZRange[0]}..${report.aircraftPosZRange[1]}; ramp posZ ` +
			`${report.rampPosZRange[0]}..${report.rampPosZRange[1]}, cross-slope ${report.rampCrossSlopeSteps} step(s); ` +
			`turret divergence ${report.turretDivergenceSamples}/606, sweep ${report.turretSweepChanges}/600; ` +
			`infantry moving ${report.infantryMovingSamples}/101; terrain.static ` +
			`${report.terrainStaticPublications} flag / ${report.terrainStaticSectionPublications} section publication(s)`,
		)
		for (const failure of report.failures.slice(0, 20)) console.error(`  ${failure}`)
		if (report.failures.length > 0) movingExitCode = 1
		await context.close()
	} catch (error) {
		console.error(`snapshotgate: FAIL --moving — ${error.message}`)
		movingExitCode = 1
	} finally {
		if (movingBrowser != null) await movingBrowser.close()
		if (movingServer != null && !flags.has('keep-server')) await stopProcessGroup(movingServer)
	}
	return movingExitCode
}

function parseFlags(argv) {
	const out = new Map()
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (!arg.startsWith('--'))
			throw new Error(`snapshotgate: unknown positional argument '${arg}'`)
		const name = arg.slice(2)
		if (VALUE_FLAGS.has(name)) {
			if (i + 1 >= argv.length)
				throw new Error(`snapshotgate: --${name} requires a value`)
			out.set(name, argv[++i])
		} else if (BOOLEAN_FLAGS.has(name))
			out.set(name, true)
		else
			throw new Error(`snapshotgate: unknown flag --${name}`)
	}
	return out
}

async function captureLiveSnapshot(activeBrowser) {
	const context = await activeBrowser.newContext({
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()
	const pageErrors = []
	page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`))

	try {
		const url = new URL(baseUrl)
		url.searchParams.set('mode', 'game')
		url.searchParams.set('platform', 'null')
		url.searchParams.set('Debug.ServerRandomSeed', String(seed))
		await page.goto(url.href, { waitUntil: 'load', timeout: 60000 })
		await page.waitForFunction(() => globalThis.steelseedBridgeReady instanceof Promise, undefined, {
			timeout: 120000,
		})

		const surface = await page.evaluate(async () => {
			const bridge = await globalThis.steelseedBridgeReady
			return {
				catalog: typeof bridge?.getSkirmishCatalog,
				start: typeof bridge?.startSkirmish,
				poll: typeof bridge?.pollSnapshot,
			}
		})
		if (surface.catalog !== 'function')
			throw new Error('GetSkirmishCatalog bridge is unavailable')
		if (surface.start !== 'function')
			throw new Error('StartSkirmish bridge is unavailable')
		if (surface.poll !== 'function')
			throw new Error('PollSnapshot export is unavailable')

		const startResult = await page.evaluate(async () => {
			const bridge = await globalThis.steelseedBridgeReady
			const catalog = await bridge.getSkirmishCatalog()
			const map = catalog.maps.find(candidate =>
				candidate.slots.length >= 2 && candidate.bots.length > 0 &&
				candidate.slots.slice(1).some(slot => slot.allowBots))
			if (map == null) throw new Error('catalog has no two-player bot-capable map')
			const faction = map.factions[0]?.id ?? 'Random'
			const botType = map.bots.find(bot => bot.id === 'normal')?.id ?? map.bots[0].id
			const botSlot = map.slots.slice(1).find(slot => slot.allowBots)
			let nextSpawn = 1
			const slots = map.slots.map((slot, index) => {
				const kind = index === 0 ? 'human' : slot === botSlot || slot.required ? 'bot' : 'closed'
				return {
					slot: slot.id,
					kind,
					botType: kind === 'bot' ? botType : null,
					faction,
					color: map.colors[index % map.colors.length] ?? slot.defaults.color,
					team: 0,
					spawn: nextSpawn++,
				}
			})
			return await bridge.startSkirmish({
				schemaVersion: catalog.schemaVersion,
				transport: 'local',
				randomSeed: 104729,
				mapUid: map.uid,
				gameSpeed: catalog.defaultGameSpeed,
				local: {
					slot: map.slots[0].id,
					name: 'Snapshot Gate',
					faction,
					color: map.colors[0] ?? map.slots[0].defaults.color,
					team: 0,
					spawn: 1,
				},
				slots,
				options: Object.fromEntries(map.options.map(option => [option.id, option.defaultValue])),
			})
		})
		if (startResult.status !== 'loading' && startResult.status !== 'running')
			throw new Error(`StartSkirmish returned ${JSON.stringify(startResult)}`)

		const snapshot = await page.evaluate(async deadlineMs => {
			const P = globalThis.ora
			const bridge = await globalThis.steelseedBridgeReady
			const deadline = performance.now() + deadlineMs
			const nextFrame = () => new Promise(resolveFrame => requestAnimationFrame(resolveFrame))
			while (performance.now() <= deadline) {
				const memoryView = bridge.pollSnapshot()
				if (memoryView !== null) {
					const declaredByteLength = new DataView(
						memoryView.buffer,
						memoryView.byteOffset,
						memoryView.byteLength,
					).getUint32(8, true)
					const bytes = memoryView.slice(0, declaredByteLength)
					let binary = ''
					for (let i = 0; i < bytes.byteLength; i += 0x8000)
						binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
					return { base64: btoa(binary), byteLength: bytes.byteLength }
				}
				await nextFrame()
			}
			throw new Error(`timed out after ${deadlineMs}ms waiting for PollSnapshot`)
		}, timeoutMs)

		if (pageErrors.length > 0)
			throw new Error(pageErrors[0])
		const bytes = Buffer.from(snapshot.base64, 'base64')
		if (bytes.byteLength !== snapshot.byteLength)
			throw new Error(
				`base64 copy length ${bytes.byteLength} != MemoryView length ${snapshot.byteLength}`,
			)
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
	} finally {
		await context.close()
	}
}

function decoderAcceptance(buffer) {
	try {
		const snapshot = new SnapshotDecoder().decode(buffer)
		return {
			accepted: true,
			tick: snapshot.tick,
			headerByteLength: snapshot.byteLength,
			sectionCount: snapshot.sections.size,
		}
	} catch (error) {
		return { accepted: false, error: error.message }
	}
}

function appendTrailingByte(buffer) {
	const out = new Uint8Array(buffer.byteLength + 1)
	out.set(new Uint8Array(buffer))
	out[out.byteLength - 1] = 0xa5
	return out.buffer
}

function shrinkWorldSection(buffer) {
	const out = buffer.slice(0)
	const view = new DataView(out)
	const sectionCount = view.getUint16(6, true)
	for (let i = 0; i < sectionCount; i++) {
		const entry = V1_HEADER_BYTES + i * V1_SECTION_ENTRY_BYTES
		if (view.getUint16(entry, true) !== V1_SECTIONS.world)
			continue
		const originalLength = view.getUint32(entry + 8, true)
		if (originalLength < 4)
			throw new Error(`world section is too short to shrink (${originalLength})`)
		view.setUint32(entry + 8, originalLength - 4, true)
		return {
			buffer: out,
			detail: `shrunk world section length ${originalLength} -> ${originalLength - 4}`,
		}
	}
	throw new Error('live snapshot has no world section')
}

function validateSnapshotLayout(buffer) {
	const failures = []
	const sectionReports = []
	const fail = (code, detail) => failures.push({ code, detail })
	const actualByteLength = buffer.byteLength

	let decoded = null
	try {
		decoded = new SnapshotDecoder().decode(buffer)
	} catch (error) {
		fail('decoder', error.message)
	}

	if (actualByteLength < V1_HEADER_BYTES) {
		fail(
			'header-truncated',
			`actual buffer is ${actualByteLength} bytes, below the §4 header size ${V1_HEADER_BYTES}`,
		)
		return { actualByteLength, failures, sectionReports, unexercised: [] }
	}

	const view = new DataView(buffer)
	const magic = view.getUint32(0, true)
	const version = view.getUint16(4, true)
	const sectionCount = view.getUint16(6, true)
	const headerByteLength = view.getUint32(8, true)
	const flags = view.getUint32(24, true)
	const reserved = view.getUint32(28, true)
	const tableEnd = V1_HEADER_BYTES + sectionCount * V1_SECTION_ENTRY_BYTES

	if (magic !== V1_MAGIC)
		fail('header-magic', `magic 0x${magic.toString(16)} != §4 v1 0x${V1_MAGIC.toString(16)}`)
	if (version !== V1_VERSION)
		fail('header-version', `version ${version} != §4 version ${V1_VERSION}`)
	if (headerByteLength !== actualByteLength)
		fail(
			'header-byte-length',
			`header declares ${headerByteLength} bytes but PollSnapshot copy contains ${actualByteLength}`,
		)
	if (reserved !== 0)
		fail('header-reserved', `reserved header word is ${reserved}, expected 0`)
	if (tableEnd > actualByteLength)
		fail(
			'section-table-truncated',
			`§4 table ends at ${tableEnd}, beyond actual buffer length ${actualByteLength}`,
		)

	const rawSections = []
	const readableEntries = Math.max(
		0,
		Math.min(sectionCount, Math.floor((actualByteLength - V1_HEADER_BYTES) / V1_SECTION_ENTRY_BYTES)),
	)
	for (let i = 0; i < readableEntries; i++) {
		const entry = V1_HEADER_BYTES + i * V1_SECTION_ENTRY_BYTES
		const id = view.getUint16(entry, true)
		const sectionFlags = view.getUint16(entry + 2, true)
		const offset = view.getUint32(entry + 4, true)
		const length = view.getUint32(entry + 8, true)
		rawSections.push({ tableIndex: i, id, sectionFlags, offset, length })
		if (sectionFlags !== 0)
			fail('section-flags', `section ${sectionName(id)} has v1 flags ${sectionFlags}, expected 0`)
		if ((offset & 3) !== 0)
			fail('section-alignment', `section ${sectionName(id)} starts at unaligned byte ${offset}`)
		if ((length & 3) !== 0)
			fail('section-alignment', `section ${sectionName(id)} length ${length} is not 4-byte aligned`)
		if (offset + length > actualByteLength)
			fail(
				'section-actual-bounds',
				`section ${sectionName(id)} [${offset}, ${offset + length}) exceeds actual ${actualByteLength}`,
			)
		if (offset + length > headerByteLength)
			fail(
				'section-header-bounds',
				`section ${sectionName(id)} [${offset}, ${offset + length}) exceeds header ${headerByteLength}`,
			)
	}

	// The table follows payload write order (notably projectiles/deployments are late
	// collectors). Offsets, not table order, define physical coverage below.
	for (let i = 0; i < rawSections.length; i++) {
		const section = rawSections[i]
		// Section IDs identify layouts; byte offsets, checked below, define packing order.
		if (rawSections.some((other, j) => j < i && other.id === section.id))
			fail('section-duplicate', `section id ${section.id} appears more than once`)
	}

	// The header and table claim [0, tableEnd). Each sorted section must begin where
	// the previous claimed interval ended. Equality detects gaps and overlaps alike.
	let claimedEnd = tableEnd
	for (const section of [...rawSections].sort((a, b) => a.offset - b.offset)) {
		if (section.offset !== claimedEnd) {
			const kind = section.offset < claimedEnd ? 'overlap' : 'gap'
			fail(
				`section-${kind}`,
				`${sectionName(section.id)} starts at ${section.offset}; previous claim ends at ${claimedEnd}`,
			)
		}
		claimedEnd = Math.max(claimedEnd, section.offset + section.length)
	}
	if (claimedEnd !== headerByteLength)
		fail(
			'unclaimed-header-bytes',
			`table/sections claim through ${claimedEnd}, header declares ${headerByteLength}`,
		)
	if (claimedEnd !== actualByteLength)
		fail(
			'unclaimed-actual-bytes',
			`table/sections claim through ${claimedEnd}, actual buffer ends at ${actualByteLength}`,
		)

	if (decoded != null) {
		if (decoded.sections.size !== sectionCount)
			fail(
				'decoder-section-count',
				`decoder exposes ${decoded.sections.size} unique sections, table declares ${sectionCount}`,
			)
		for (const section of rawSections) {
			const decodedSection = decoded.sections.get(section.id)
			if (decodedSection == null)
				fail('decoder-section-missing', `decoder omitted section ${sectionName(section.id)}`)
			else if (
				decodedSection[0] !== section.offset ||
				decodedSection[1] !== section.length
			)
				fail(
					'decoder-section-table',
					`decoder reports ${sectionName(section.id)} ` +
						`[${decodedSection[0]}, ${decodedSection[1]}], table has ` +
						`[${section.offset}, ${section.length}]`,
				)
		}
	}

	const rawIds = new Set(rawSections.map(section => section.id))
	for (const required of LIVE_FIXTURE_SECTIONS) {
		if (!rawIds.has(required))
			fail(
				'fixture-section-missing',
				`first live PollSnapshot did not exercise required ${sectionName(required)} section`,
			)
	}
	const terrainPresent = rawIds.has(V1_SECTIONS.terrainStatic)
	if (Boolean(flags & 1) !== terrainPresent)
		fail(
			'terrain-static-flag',
			`header terrain.static bit=${Boolean(flags & 1)} but section present=${terrainPresent}`,
		)

	for (const section of rawSections) {
		try {
			const expected = expectedSectionLength(view, section, decoded, headerByteLength)
			sectionReports.push({
				id: section.id,
				name: sectionName(section.id),
				offset: section.offset,
				declared: section.length,
				expected: expected.length,
				counts: expected.counts,
			})
			if (section.length !== expected.length)
				fail(
					'section-length',
					`${sectionName(section.id)} declares ${section.length} bytes; ` +
						`independent §4 calculation is ${expected.length}` +
						(expected.counts == null ? '' : ` (${expected.counts})`),
				)
		} catch (error) {
			fail('section-layout', `${sectionName(section.id)}: ${error.message}`)
		}
	}

	const unexercised = SECTION_NAMES
		.map((name, id) => ({ id, name }))
		.filter(section => !rawIds.has(section.id))

	return {
		tick: decoded?.tick,
		actualByteLength,
		headerByteLength,
		sectionCount,
		claimedByteLength: claimedEnd,
		sectionReports,
		unexercised,
		failures,
	}
}

// Every byte count below is spelled out from ARCHITECTURE.md §4. No decoder
// constants or offset helpers are used. Decoded counts are cross-checked where the
// decoder exposes a typed view; §4 sections it does not expose are walked raw.
function expectedSectionLength(view, section, decoded, headerByteLength) {
	const { id, offset: o } = section
	const limit = Math.min(view.byteLength, headerByteLength)
	switch (id) {
		case V1_SECTIONS.world:
			// i32×4 + u32 cellSize + u16 renderPlayer + u8 map/session + u32 environment mask.
			// OpenRA RA emits no simulation-authored environment payload.
			return { length: 4 * 4 + 4 + 2 + 1 + 1 + 4 }

		case V1_SECTIONS.terrainStatic: {
			const w = readU32(view, o, limit, 'terrain.static width')
			const h = readU32(view, o + 4, limit, 'terrain.static height')
			const cells = safeProduct(w, h, 'terrain.static cells')
			if (decoded?.terrainStatic != null) {
				assertEqual(decoded.terrainStatic.w, w, 'decoded terrain.static width')
				assertEqual(decoded.terrainStatic.h, h, 'decoded terrain.static height')
			}
			// u32 w/h + six independently 4-byte-padded u8[cellCount] planes.
			return { length: 8 + 6 * align4(cells), counts: `${w}×${h}=${cells} cells` }
		}

		case V1_SECTIONS.terrainDelta: {
			let p = o
			const resources = readU32(view, p, limit, 'terrain.delta resourceChangeCount')
			p = safeAdvance(p + 4, resources, 8, limit, 'terrain.delta resources')
			const craters = readU32(view, p, limit, 'terrain.delta craterCount')
			p = safeAdvance(p + 4, craters, 16, limit, 'terrain.delta craters')
			const bridges = readU32(view, p, limit, 'terrain.delta bridgeChangeCount')
			p = safeAdvance(p + 4, bridges, 8, limit, 'terrain.delta bridges')
			return {
				length: align4(p - o),
				counts: `${resources} resources, ${craters} craters, ${bridges} bridges (raw; no JS view)`,
			}
		}

		case V1_SECTIONS.resources: {
			const w = view.getUint16(o, true)
			const h = view.getUint16(o + 2, true)
			const cells = safeProduct(w, h, 'resources cells')
			if (decoded?.resources != null) {
				assertEqual(decoded.resources.w, w, 'decoded resources width')
				assertEqual(decoded.resources.h, h, 'decoded resources height')
				assertEqual(decoded.resources.type.length, cells, 'decoded resource cell count')
			}
			return { length: align4(8 + 3 * cells), counts: `${w}×${h}=${cells} resource cells` }
		}

		case V1_SECTIONS.actors: {
			const actors = readU32(view, o, limit, 'actors count')
			const turrets = readU32(view, o + 4, limit, 'actors turretTotal')
			if (decoded?.actors != null) {
				assertEqual(decoded.actors.count, actors, 'decoded actors count')
				assertEqual(decoded.actors.turretTotal, turrets, 'decoded actors turretTotal')
			}
			// Header + four 4-byte arrays + six 2-byte arrays + nine 1-byte arrays
			// + one presentation-only 2-byte display-type array + turret facings.
			let p = 8 + actors * (4 * 4 + 6 * 2)
			p = align4(p)
			p += actors * 9
			p = align4(p)
			p += actors * 2
			p = align4(p)
			p += turrets * 2
			p = align4(p) + actors * 4 // immutable falling-husk source identity
			return {
				length: align4(p),
				counts: `${actors} actors, ${turrets} turrets`,
			}
		}

		case V1_SECTIONS.lifecycle: {
			const count = readU32(view, o, limit, 'actors.lifecycle count')
			if (decoded != null)
				assertEqual(decoded.lifecycle.length, count, 'decoded actors.lifecycle count')
			return { length: align4(4 + count * 8), counts: `${count} records` }
		}

		case V1_SECTIONS.projectiles: {
			const count = readU32(view, o, limit, 'projectiles count')
			if (decoded?.projectiles != null)
				assertEqual(decoded.projectiles.count, count, 'decoded projectiles count')
			// Four 4-byte arrays + five 2-byte arrays = 26 bytes/projectile.
			return { length: align4(4 + count * 43) + count * 20, counts: `${count} projectiles` }
		}

		case V1_SECTIONS.deployments: {
			const deploymentCount = readU32(view, o, limit, 'deployments count')
			return { length: align4(4 + deploymentCount * 32), counts: `${deploymentCount} deployments` }
		}

		// §4.10c: u32 count, then 12-byte records {u32 actor, u8 kind (1 curtain, 2 chrono return), u8 0,
		// u16 remaining, u16 total, u16 0}.
		case V1_SECTIONS.actorStatus: {
			const count = readU32(view, o, limit, 'actors.status count')
			for (let r = 0; r < count; r++) {
				const kind = view.getUint8(o + 4 + r * 12 + 4)
				if (kind !== 1 && kind !== 2) throw new Error(`actors.status record ${r}: unknown kind ${kind}`)
			}
			if (decoded != null) assertEqual(decoded.actorStatus?.count ?? 0, count, 'decoded actors.status count')
			return { length: 4 + count * 12, counts: `${count} actor states` }
		}

		case V1_SECTIONS.frozenActors: {
			const count = readU32(view, o, limit, 'frozen actors count')
			if (decoded?.frozenActors != null)
				assertEqual(decoded.frozenActors.count, count, 'decoded frozen actors count')
			// Header + four 4-byte arrays + one 2-byte array, then owner/health byte arrays.
			let p = 4 + count * (4 * 4 + 2)
			p = align4(p)
			p += count * 2
			return { length: align4(p), counts: `${count} remembered structures` }
		}

		case V1_SECTIONS.shroud: {
			const count = readU32(view, o, limit, 'shroud runCount')
			if (decoded != null)
				assertEqual(decoded.shroud.length, count, 'decoded shroud runCount')
			return { length: align4(4 + count * 8), counts: `${count} runs` }
		}

		case V1_SECTIONS.events: {
			const count = readU32(view, o, limit, 'events eventCount')
			if (decoded != null)
				assertEqual(decoded.events.length, count, 'decoded events eventCount')
			let p = o + 4
			for (let i = 0; i < count; i++) {
				requireRange(p, 4, limit, `events record ${i} header`)
				const payloadBytes = view.getUint16(p + 2, true)
				requireRange(p + 4, payloadBytes, limit, `events record ${i} payload`)
				p = align4(p + 4 + payloadBytes)
			}
			return { length: align4(p - o), counts: `${count} records` }
		}

		case V1_SECTIONS.player: {
			const count = readU32(view, o, limit, 'player playerCount')
			let p = o + 4
			let queues = 0
			for (let i = 0; i < count; i++) {
				// ABI v2 authoritative player identity/relation/RGBA fixed record = 36B.
				requireRange(p, 36, limit, `player ${i} fixed record`)
				const queueCount = view.getUint16(p + 30, true)
				queues += queueCount
				p = safeAdvance(p + 36, queueCount, 8, limit, `player ${i} queues`)
			}
			return {
				length: align4(p - o),
				counts: `${count} players, ${queues} queues`,
			}
		}

		case V1_SECTIONS.production: {
			const count = readU32(view, o, limit, 'production queueCount')
			let p = o + 4
			let items = 0
			for (let i = 0; i < count; i++) {
				requireRange(p, 12, limit, `production queue ${i} header`)
				const itemCount = view.getUint16(p + 10, true)
				items += itemCount
				p = safeAdvance(p + 12, itemCount, 12, limit, `production queue ${i} items`)
			}
			if (decoded != null) {
				assertEqual(decoded.production.length, count, 'decoded production queue count')
				let decodedItems = 0
				for (const queue of decoded.production) decodedItems += queue.items.length
				assertEqual(decodedItems, items, 'decoded production item count')
			}
			return {
				length: align4(p - o),
				counts: `${count} queues, ${items} items`,
			}
		}

		default:
			throw new Error(`unknown §4 section id ${id}; add an independent layout before accepting it`)
	}
}

function printValidationResult(result, detail) {
	const status = result.failures.length === 0 ? 'PASS' : 'FAIL'
	console.log(
		`snapshotgate: ${status} — ${detail}; tick=${result.tick ?? 'unavailable'}, ` +
		`actual=${result.actualByteLength}, header=${result.headerByteLength ?? 'unavailable'}, ` +
		`claimed=${result.claimedByteLength ?? 'unavailable'}, sections=${result.sectionCount ?? 'unavailable'}`,
	)
	for (const section of result.sectionReports) {
		console.log(
			`  section ${section.id} ${section.name}: offset=${section.offset}, ` +
			`declared=${section.declared}, expected=${section.expected}` +
			(section.counts == null ? '' : `; ${section.counts}`),
		)
	}
	if (result.unexercised.length > 0)
		console.log(
			`  not exercised by this live fixture: ` +
			result.unexercised.map(section => `${section.id}:${section.name}`).join(', '),
		)
	for (const failure of result.failures)
		console.error(`  [${failure.code}] ${failure.detail}`)
}

function sectionName(id) {
	return SECTION_NAMES[id] ?? `unknown(${id})`
}

function align4(value) {
	return Math.ceil(value / 4) * 4
}

function safeProduct(a, b, label) {
	const product = a * b
	if (!Number.isSafeInteger(product))
		throw new Error(`${label} overflows safe integer arithmetic (${a} × ${b})`)
	return product
}

function safeAdvance(start, count, bytesPerElement, limit, label) {
	const bytes = safeProduct(count, bytesPerElement, label)
	requireRange(start, bytes, limit, label)
	return start + bytes
}

function requireRange(offset, length, limit, label) {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		offset + length > limit
	)
		throw new Error(`${label} [${offset}, ${offset + length}) exceeds byte ${limit}`)
}

function readU32(view, offset, limit, label) {
	requireRange(offset, 4, limit, label)
	return view.getUint32(offset, true)
}

function assertEqual(actual, expected, label) {
	if (actual !== expected)
		throw new Error(`${label} ${actual} != raw count ${expected}`)
}

async function launchBrowser() {
	try {
		return await chromium.launch({ headless: true })
	} catch (error) {
		if (!/Executable doesn't exist/.test(String(error.message)))
			throw error
		console.log('snapshotgate: bundled Chromium is absent; using installed Chrome')
		return chromium.launch({ headless: true, channel: 'chrome' })
	}
}

async function waitForServer(url, timeout, child) {
	const deadline = Date.now() + timeout
	while (Date.now() < deadline) {
		if (child.exitCode != null || child.signalCode != null)
			throw new Error(
				`static server exited early ` +
				`(code=${child.exitCode}, signal=${child.signalCode})`,
			)
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
	throw new Error(`static server did not come up at ${url} within ${timeout}ms`)
}

function positiveInteger(value, name) {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`snapshotgate: --${name} must be a positive integer (received '${value}')`)
	return parsed
}

function unsignedInteger(value, name) {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff)
		throw new Error(`snapshotgate: --${name} must be a u32 integer (received '${value}')`)
	return parsed
}
