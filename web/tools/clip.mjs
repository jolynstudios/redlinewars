#!/usr/bin/env node
// STEELSEED — tools/clip
// Deterministic motion evidence: a visual strip plus machine-readable probe series.
//
// The JSON is the gate surface. The strip is compact human context for the same frames;
// no assertion depends on somebody noticing a jump by eye. `--falsify=snap` forces the
// interpolation alpha to one and must trip the tracked-root discontinuity metric.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng } from './png.mjs'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME_ROOT = resolve(WEB_ROOT, '..')
const VALUE_FLAGS = new Set([
	'out', 'url', 'name', 'frames', 'width', 'height', 'tile-width', 'tile-height',
	'quality', 'seed', 'port', 'timeout-ms', 'falsify', 'threshold-px', 'focus',
])
const BOOLEAN_FLAGS = new Set(['keep-server'])
const flags = parseFlags(process.argv.slice(2))
const flag = (name, fallback) => flags.has(name) ? flags.get(name) : fallback

const name = safeName(flag('name', 'motion'))
const frames = integerInRange(flag('frames', 24), 'frames', 6, 120)
const width = integerInRange(flag('width', 960), 'width', 320, 4096)
const height = integerInRange(flag('height', 540), 'height', 180, 2160)
const tileWidth = integerInRange(flag('tile-width', 240), 'tile-width', 80, 640)
const tileHeight = integerInRange(flag('tile-height', 135), 'tile-height', 45, 360)
if (tileWidth * frames > 32767)
	throw new Error(`clip: horizontal strip width ${tileWidth * frames}px exceeds the 32767px canvas limit`)
const quality = flag('quality', 'low')
if (!['low', 'medium', 'high'].includes(quality))
	throw new Error(`clip: --quality must be low, medium, or high (received '${quality}')`)
const seed = String(flag('seed', 'steelseed-motion'))
const port = integerInRange(flag('port', 8379), 'port', 1, 65535)
const timeoutMs = integerInRange(flag('timeout-ms', 240000), 'timeout-ms', 1000, 600000)
const falsifier = flag('falsify', 'none')
if (!['none', 'snap'].includes(falsifier))
	throw new Error(`clip: unknown falsifier '${falsifier}'`)
const thresholdPx = finiteInRange(flag('threshold-px', 0.5), 'threshold-px', 0.01, 100)
const focus = String(flag('focus', 'motion'))
if (focus !== 'motion' && focus !== 'turret')
	throw new Error(`clip: --focus must be motion or turret (received '${focus}')`)
const outDir = resolve(flag('out', join(GAME_ROOT, '.artifacts', 'clips')))
const stripPath = join(outDir, `${name}-strip.png`)
const seriesPath = join(outDir, `${name}-series.json`)
const suppliedUrl = flag('url', null)
const baseUrl = suppliedUrl ?? `http://127.0.0.1:${port}/`

let chromium
try {
	;({ chromium } = await import('playwright'))
} catch {
	console.error(
		'clip: playwright is not installed.\n' +
		'  cd web && npm install && npx playwright install chromium',
	)
	process.exit(2)
}

let server = null
let browser = null
let exitCode = 0

try {
	if (suppliedUrl == null) {
		server = spawnProcessGroup('npx', [
			'vite', 'preview',
			'--host', '127.0.0.1',
			'--port', String(port),
			'--strictPort',
		], {
			cwd: WEB_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		await waitForServer(baseUrl, 30000, server)
	}

	browser = await launchBrowser()
	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()
	const browserErrors = []
	page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`))
	page.on('console', message => {
		if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
			browserErrors.push(`console.error: ${message.text()}`)
	})
	page.on('response', response => {
		if (response.status() < 400) return
		if (new URL(response.url()).pathname === '/favicon.ico') return
		browserErrors.push(`http ${response.status()}: ${response.url()}`)
	})

	const url = new URL(baseUrl)
	url.searchParams.set('devmap', '1')
	url.searchParams.set('deterministic', '1')
	url.searchParams.set('manual', '1')
	url.searchParams.set('devfps', '60')
	url.searchParams.set('quality', quality)
	url.searchParams.set('seed', seed)
	await page.goto(url.href, { waitUntil: 'load', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined, { timeout: timeoutMs })

	const capture = await page.evaluate(
		({ frameCount, tileW, tileH, snap, maxDiscontinuityPx, focusMode }) => {
			const app = globalThis.steelseed
			const cameraSystem = app.registry.peek('camera')
			const render = app.registry.peek('render')
			const terrain = app.registry.peek('terrain')
			if (cameraSystem == null || render == null || terrain == null)
				throw new Error('clip requires camera, render, and terrain systems')

			if (snap) {
				const advance = app.clock.frame.bind(app.clock)
				app.clock.frame = atMs => {
					const dt = advance(atMs)
					app.clock.time.alpha = 1
					return dt
				}
			}

			const FRAME_MS = 1000 / 60
			let renderedFrames = 0
			const renderNext = () => app.renderOneFrame(renderedFrames++ * FRAME_MS)

			// Bootstrap terrain, then pin every camera degree of freedom by value. Merely
			// declining to send input is not a fixed camera: first-snapshot bounds adoption
			// changes the target and zoom damping can retain a previous goal.
			renderNext()
			const world = app.ctx.snapshot?.world
			if (world == null) throw new Error('moving fixture produced no world section')
			let targetX = (world.boundsLeft + world.boundsRight) * 0.5
			let targetZ = (world.boundsTop + world.boundsBottom) * 0.5
			if (focusMode === 'turret') {
				const actors = app.ctx.snapshot?.actors
				if (actors == null) throw new Error('turret focus requires an actors section')
				let leader = -1
				for (let i = 0; i < actors.count; i++) if (actors.id[i] === 1) { leader = i; break }
				if (leader < 0) throw new Error('turret focus actor 1 is missing')
				targetX = actors.posX[leader] / 1024
				targetZ = actors.posY[leader] / 1024
			}
			const targetY = terrain.heightAt(targetX, targetZ)
			const cameraHeight = focusMode === 'turret' ? 9 : 32
			cameraSystem.target.set([targetX, targetY, targetZ])
			cameraSystem.targetGoal.set([targetX, targetY, targetZ])
			cameraSystem.height = cameraHeight
			cameraSystem.heightGoal = cameraHeight
			cameraSystem.yaw = 0.55
			cameraSystem.yawGoal = 0.55
			cameraSystem.boundsKnown = true
			cameraSystem.boundsMinX = world.boundsLeft
			cameraSystem.boundsMaxX = world.boundsRight
			cameraSystem.boundsMinZ = world.boundsTop
			cameraSystem.boundsMaxZ = world.boundsBottom
			renderNext()
			while (app.ctx.prevSnapshot == null && renderedFrames < 12) renderNext()
			if (app.ctx.prevSnapshot == null)
				throw new Error('prevSnapshot stayed null through 12 deterministic warm-up frames')

			const pinnedView = Array.from(render.camera.view)
			const pinnedProj = Array.from(render.camera.proj)

			const definitions = [
				{ id: 'tracked.root', actorId: 1, semantic: 'tracked column leader root' },
				{ id: 'ramp.root', actorId: 6, semantic: 'tracked ramp root' },
				{ id: 'aircraft.root', actorId: 7, semantic: 'climbing aircraft root' },
				{ id: 'infantry.root', actorId: 8, semantic: 'walking infantry root' },
			]
			const probes = Object.fromEntries(definitions.map(definition => [definition.id, {
				definition: {
					...definition,
					source: definition.id === 'tracked.root'
						? 'renderer-instance-matrix'
						: 'snapshot-linear-reference',
					worldSpace: 'render metres (+Y up)',
					screenSpace: 'CSS pixels from top-left',
				},
				samples: [],
			}]))
			probes['tracked.turret'] = {
				definition: {
					id: 'tracked.turret',
					actorId: 1,
					semantic: 'actual skinned turret segment tip',
					source: 'renderer-bone-palette',
					worldSpace: 'render metres (+Y up)',
					screenSpace: 'CSS pixels from top-left',
				},
				samples: [],
			}
			const frameSeries = []
			let cameraMaxDelta = 0

			const round = value => Math.round(value * 1e6) / 1e6
			const project = worldM => {
				const m = render.camera.viewProj
				const x = worldM[0]
				const y = worldM[1]
				const z = worldM[2]
				const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
				const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
				const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
				if (Math.abs(cw) < 1e-9) return { screenPx: [null, null], visible: false }
				const ndcX = cx / cw
				const ndcY = cy / cw
				return {
					screenPx: [round((ndcX * 0.5 + 0.5) * innerWidth), round((0.5 - ndcY * 0.5) * innerHeight)],
					visible: cw > 0 && Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1,
				}
			}
			const actorIndex = (actors, id) => {
				let lo = 0
				let hi = actors.count - 1
				while (lo <= hi) {
					const mid = (lo + hi) >>> 1
					const value = actors.id[mid]
					if (value === id) return mid
					if (value < id) lo = mid + 1
					else hi = mid - 1
				}
				return -1
			}
			const transformPoint = (matrices, offset, point) => [
				matrices[offset] * point[0] + matrices[offset + 4] * point[1] + matrices[offset + 8] * point[2] + matrices[offset + 12],
				matrices[offset + 1] * point[0] + matrices[offset + 5] * point[1] + matrices[offset + 9] * point[2] + matrices[offset + 13],
				matrices[offset + 2] * point[0] + matrices[offset + 6] * point[1] + matrices[offset + 10] * point[2] + matrices[offset + 14],
			]
			const wrapAngle = radians => {
				const turn = Math.PI * 2
				return ((radians + Math.PI) % turn + turn) % turn - Math.PI
			}
			const lerpWAngle = (a, b, t) => {
				let delta = b - a
				if (delta > 512) delta -= 1024
				else if (delta < -512) delta += 1024
				return ((a + delta * t) % 1024 + 1024) % 1024
			}

			for (let frame = 0; frame < frameCount; frame++) {
				renderNext()
				const current = app.ctx.snapshot
				const previous = app.ctx.prevSnapshot
				if (current?.actors == null || previous?.actors == null)
					throw new Error(`frame ${frame}: current/previous actor view is null`)

				for (let i = 0; i < pinnedView.length; i++)
					cameraMaxDelta = Math.max(cameraMaxDelta, Math.abs(render.camera.view[i] - pinnedView[i]))
				for (let i = 0; i < pinnedProj.length; i++)
					cameraMaxDelta = Math.max(cameraMaxDelta, Math.abs(render.camera.proj[i] - pinnedProj[i]))

				const alpha = app.ctx.time.alpha
				frameSeries.push({
					frame,
					renderTimeMs: round((renderedFrames - 1) * FRAME_MS),
					tick: current.tick,
					previousTick: previous.tick,
					alpha: round(alpha),
				})

				for (const definition of definitions) {
					// The tracked root is read below from the renderer's submitted instance
					// matrix. Computing the ideal snapshot lerp here would let an un-interpolated
					// units node pass the interpolation gate by measuring the expected answer.
					if (definition.id === 'tracked.root') continue
					const ci = actorIndex(current.actors, definition.actorId)
					const pi = actorIndex(previous.actors, definition.actorId)
					if (ci < 0 || pi < 0) throw new Error(`probe ${definition.id}: actor ${definition.actorId} missing`)
					const currentWPos = [current.actors.posX[ci], current.actors.posY[ci], current.actors.posZ[ci]]
					const previousWPos = [previous.actors.posX[pi], previous.actors.posY[pi], previous.actors.posZ[pi]]
					const interpolatedWPos = currentWPos.map((value, axis) => previousWPos[axis] + (value - previousWPos[axis]) * alpha)
					const worldM = [interpolatedWPos[0] / 1024, interpolatedWPos[2] / 1024, interpolatedWPos[1] / 1024].map(round)
					const projected = project(worldM)
					const turretIndex = current.actors.turretOffset[ci]
					const turretFacing = current.actors.turretCount[ci] > 0
						? current.actors.turretFacing[turretIndex]
						: null
					probes[definition.id].samples.push({
						frame,
						tick: current.tick,
						alpha: round(alpha),
						currentWPos,
						previousWPos,
						worldM,
						screenPx: projected.screenPx,
						visible: projected.visible,
						speedWDistPerTick: current.actors.speed[ci],
						facingWAngle: current.actors.facing[ci],
						turretFacingWAngle: turretFacing,
						moving: (current.actors.flags[ci] & (1 << 6)) !== 0,
					})
				}

				// Read the palette entry and source-instance transform that the renderer consumes.
				// This is deliberately not reconstructed from turretFacing: a disconnected palette
				// channel could carry correct snapshot numbers while the mesh stayed still.
				const leader = actorIndex(current.actors, 1)
				const units = app.registry.peek('units')
				if (leader < 0 || units == null) throw new Error('tracked turret probe cannot resolve actor 1 or units')
				const slotName = app.ctx.actorTypeName(current.actors.typeId[leader])
				const bucket = units.slotBuckets.get(slotName)
				if (bucket?.rig == null || bucket.paletteBases == null)
					throw new Error(`tracked turret probe found no rig or palette channel for ${slotName}`)
				let sourceInstance = 0
				for (let actor = 0; actor < leader; actor++) {
					if (app.ctx.actorTypeName(current.actors.typeId[actor]) === slotName) sourceInstance++
				}
				const paletteBase = bucket.paletteBases[sourceInstance]
				if (!(paletteBase > 0)) throw new Error(`tracked turret probe has palette base ${paletteBase}`)
				const bone = bucket.rig.turretBone
				const bindOffset = bone * 3
				const bindPoint = [
					bucket.rig.skeleton.tail[bindOffset],
					bucket.rig.skeleton.tail[bindOffset + 1],
					bucket.rig.skeleton.tail[bindOffset + 2],
				]
				const paletteOffset = (paletteBase + bone) * 16
				const posedLocal = transformPoint(render.boneData, paletteOffset, bindPoint)
				const modelOffset = sourceInstance * 16
				const rootWorld = [
					bucket.instances[modelOffset + 12],
					bucket.instances[modelOffset + 13],
					bucket.instances[modelOffset + 14],
				].map(round)
				const rootProjected = project(rootWorld)
				const previousLeader = actorIndex(previous.actors, 1)
				if (previousLeader < 0) throw new Error('tracked root probe cannot resolve actor 1 in previous snapshot')
				probes['tracked.root'].samples.push({
					frame,
					tick: current.tick,
					alpha: round(alpha),
					currentWPos: [
						current.actors.posX[leader],
						current.actors.posY[leader],
						current.actors.posZ[leader],
					],
					previousWPos: [
						previous.actors.posX[previousLeader],
						previous.actors.posY[previousLeader],
						previous.actors.posZ[previousLeader],
					],
					worldM: rootWorld,
					screenPx: rootProjected.screenPx,
					visible: rootProjected.visible,
					speedWDistPerTick: current.actors.speed[leader],
					facingWAngle: current.actors.facing[leader],
					turretFacingWAngle: current.actors.turretFacing[current.actors.turretOffset[leader]],
					moving: (current.actors.flags[leader] & (1 << 6)) !== 0,
				})
				const posedWorld = transformPoint(bucket.instances, modelOffset, posedLocal).map(round)
				const projected = project(posedWorld)
				const rootSample = probes['tracked.root'].samples.at(-1)
				const screenOffsetPx = projected.screenPx[0] == null || rootSample.screenPx[0] == null
					? [null, null]
					: [
						round(projected.screenPx[0] - rootSample.screenPx[0]),
						round(projected.screenPx[1] - rootSample.screenPx[1]),
					]
				const actualLocalYawRad = wrapAngle(Math.atan2(-render.boneData[paletteOffset + 2], render.boneData[paletteOffset]))
				const turretIndex = current.actors.turretOffset[leader]
				const previousTurretIndex = previous.actors.turretOffset[previousLeader]
				const interpolatedHullFacing = lerpWAngle(
					previous.actors.facing[previousLeader],
					current.actors.facing[leader],
					alpha,
				)
				const interpolatedTurretFacing = previous.actors.turretCount[previousLeader] > 0
					? lerpWAngle(
						previous.actors.turretFacing[previousTurretIndex],
						current.actors.turretFacing[turretIndex],
						alpha,
					)
					: current.actors.turretFacing[turretIndex]
				const expectedLocalYawRad = wrapAngle(
					(interpolatedTurretFacing - interpolatedHullFacing) * Math.PI * 2 / 1024,
				)
				probes['tracked.turret'].samples.push({
					frame,
					tick: current.tick,
					paletteBase,
					bone,
					bindPointM: bindPoint.map(round),
					worldM: posedWorld,
					screenPx: projected.screenPx,
					screenOffsetPx,
					visible: projected.visible,
					expectedLocalYawRad: round(expectedLocalYawRad),
					actualLocalYawRad: round(actualLocalYawRad),
					settleErrorRad: round(Math.abs(wrapAngle(actualLocalYawRad - expectedLocalYawRad))),
				})
			}

			const continuity = samples => {
				let maxStep = 0
				let maxDiscontinuity = 0
				let maxAtFrame = -1
				let previousStep = null
				for (let i = 1; i < samples.length; i++) {
					const a = samples[i - 1].screenPx
					const b = samples[i].screenPx
					if (a[0] == null || b[0] == null) continue
					const step = [b[0] - a[0], b[1] - a[1]]
					maxStep = Math.max(maxStep, Math.hypot(step[0], step[1]))
					if (previousStep !== null) {
						const discontinuity = Math.hypot(step[0] - previousStep[0], step[1] - previousStep[1])
						if (discontinuity > maxDiscontinuity) {
							maxDiscontinuity = discontinuity
							maxAtFrame = i
						}
					}
					previousStep = step
				}
				return {
					maxStepPx: round(maxStep),
					maxDiscontinuityPx: round(maxDiscontinuity),
					maxDiscontinuityAtFrame: maxAtFrame,
					thresholdPx: maxDiscontinuityPx,
					pass: maxDiscontinuity <= maxDiscontinuityPx,
				}
			}

			const metrics = {
				trackedRootContinuity: continuity(probes['tracked.root'].samples),
				trackedTurretResponse: turretResponse(probes['tracked.turret'].samples),
			}
			const failures = []
			if (cameraMaxDelta > 1e-7)
				failures.push(`pinned camera matrices moved by ${cameraMaxDelta}`)
			if (!metrics.trackedRootContinuity.pass)
				failures.push(
					`tracked.root discontinuity ${metrics.trackedRootContinuity.maxDiscontinuityPx}px ` +
					`exceeds ${maxDiscontinuityPx}px at frame ${metrics.trackedRootContinuity.maxDiscontinuityAtFrame}`,
				)
			if (!metrics.trackedTurretResponse.pass)
				failures.push(
					`tracked.turret response failed: max settle error ${metrics.trackedTurretResponse.maxSettleErrorRad} rad, ` +
					`minimum unwrapped step ${metrics.trackedTurretResponse.minStepRad} rad, ` +
					`relative travel ${metrics.trackedTurretResponse.relativeTravelPx}px`,
				)
			if (snap && metrics.trackedRootContinuity.pass)
				failures.push('--falsify=snap did not trip the tracked.root discontinuity metric')

			return {
				report: {
					schema: 'steelseed.clip.v1',
					fixture: {
						deterministic: true,
						simHz: 25,
						renderFps: 60,
						capturedFrames: frameCount,
						warmupFrames: renderedFrames - frameCount,
						falsifier: snap ? 'snap' : null,
					},
					camera: {
						pin: 'programmatic',
						targetM: [round(targetX), round(targetY), round(targetZ)],
						heightM: cameraHeight,
						yawRad: 0.55,
						maxMatrixDelta: round(cameraMaxDelta),
						view: pinnedView.map(round),
						projection: pinnedProj.map(round),
					},
					strip: { width: tileW * frameCount, height: tileH, tileWidth: tileW, tileHeight: tileH },
					frames: frameSeries,
					probes,
					metrics,
					failures,
				},
			}

			function turretResponse(samples) {
				let maxSettleError = 0
				let minStep = Infinity
				let maxStep = 0
				let relativeTravel = 0
				const firstOffset = samples[0]?.screenOffsetPx
				for (let i = 0; i < samples.length; i++) {
					maxSettleError = Math.max(maxSettleError, samples[i].settleErrorRad)
					if (i > 0) {
						const step = wrapAngle(samples[i].actualLocalYawRad - samples[i - 1].actualLocalYawRad)
						minStep = Math.min(minStep, step)
						maxStep = Math.max(maxStep, step)
					}
					const offset = samples[i].screenOffsetPx
					if (firstOffset?.[0] != null && offset?.[0] != null)
						relativeTravel = Math.max(relativeTravel, Math.hypot(offset[0] - firstOffset[0], offset[1] - firstOffset[1]))
				}
				if (minStep === Infinity) minStep = 0
				return {
					maxSettleErrorRad: round(maxSettleError),
					minStepRad: round(minStep),
					maxStepRad: round(maxStep),
					relativeTravelPx: round(relativeTravel),
					// Render runs at 60 Hz and the fixture at 25 Hz, so repeated ticks legitimately
					// produce zero steps. Monotonic means non-decreasing, with at least one real move.
					pass: maxSettleError <= 1e-5 && minStep >= -1e-6 && maxStep > 0 && relativeTravel >= 0.5,
				}
			}
		},
		{
			frameCount: frames,
			tileW: tileWidth,
			tileH: tileHeight,
			snap: falsifier === 'snap',
			maxDiscontinuityPx: thresholdPx,
			focusMode: focus,
		},
	)
	// Read the presented canvas one frame at a time. Packing every frame with drawImage()
	// inside one JS task races the GPU queue: measured on this fixture, the numeric series
	// was byte-identical while 0.63% of strip pixels varied by up to 5 channels between
	// runs. Playwright's element screenshot waits for composition; the deterministic Node
	// packer below then builds one PNG without browser encoder metadata.
	const stableStrip = await captureStableStrip(page, url.href, {
		frames,
		tileWidth,
		tileHeight,
		falsifySnap: falsifier === 'snap',
		focus,
		timeoutMs,
	})

	capture.report.fixture.seed = seed
	capture.report.fixture.quality = quality
	capture.report.pixelProbe = stableStrip.pixelProbe
	if (stableStrip.pixelProbe.maxChannel === 0) capture.report.failures.push('strip is entirely black')
	if (stableStrip.pixelProbe.colourBuckets <= 1)
		capture.report.failures.push(`strip has ${stableStrip.pixelProbe.colourBuckets} colour bucket; world was not visibly drawn`)
	for (const error of browserErrors) capture.report.failures.push(error)
	mkdirSync(outDir, { recursive: true })
	writeFileSync(stripPath, stableStrip.png)
	writeFileSync(seriesPath, `${JSON.stringify(capture.report, null, 2)}\n`)

	const metric = capture.report.metrics.trackedRootContinuity
	const turretMetric = capture.report.metrics.trackedTurretResponse
	if (capture.report.failures.length > 0) {
		console.error(
			`clip: FAIL — ${frames} frames; tracked.root max step ${metric.maxStepPx}px, ` +
			`max discontinuity ${metric.maxDiscontinuityPx}px (limit ${metric.thresholdPx}px); ` +
			`camera delta ${capture.report.camera.maxMatrixDelta}; ${capture.report.failures.length} failure(s)`,
		)
		for (const failure of capture.report.failures.slice(0, 20)) console.error(`  ${failure}`)
		exitCode = 1
	} else {
		console.log(
			`clip: PASS — ${frames} frames; tracked.root max step ${metric.maxStepPx}px, ` +
			`max discontinuity ${metric.maxDiscontinuityPx}px (limit ${metric.thresholdPx}px); ` +
			`camera delta ${capture.report.camera.maxMatrixDelta}; ` +
			`turret settle ${turretMetric.maxSettleErrorRad} rad, travel ${turretMetric.relativeTravelPx}px; ` +
			`${capture.report.pixelProbe.colourBuckets} colour buckets`,
		)
	}
	console.log(`  strip:  ${stripPath}`)
	console.log(`  series: ${seriesPath}`)
	await context.close()
} catch (error) {
	console.error(`clip: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null) await browser.close()
	if (server != null && !flags.has('keep-server')) await stopProcessGroup(server)
}

process.exit(exitCode)

function parseFlags(argv) {
	const out = new Map()
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (!arg.startsWith('--')) throw new Error(`clip: unknown positional argument '${arg}'`)
		const body = arg.slice(2)
		const eq = body.indexOf('=')
		const name = eq >= 0 ? body.slice(0, eq) : body
		if (VALUE_FLAGS.has(name)) {
			const value = eq >= 0 ? body.slice(eq + 1) : argv[++i]
			if (value == null || value === '') throw new Error(`clip: --${name} requires a value`)
			out.set(name, value)
		} else if (BOOLEAN_FLAGS.has(name) && eq < 0) out.set(name, true)
		else throw new Error(`clip: unknown flag --${body}`)
	}
	return out
}

function integerInRange(value, name, lo, hi) {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < lo || parsed > hi)
		throw new Error(`clip: --${name} must be an integer in [${lo}, ${hi}] (received '${value}')`)
	return parsed
}

function finiteInRange(value, name, lo, hi) {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < lo || parsed > hi)
		throw new Error(`clip: --${name} must be in [${lo}, ${hi}] (received '${value}')`)
	return parsed
}

function safeName(value) {
	const name = String(value)
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
		throw new Error(`clip: --name contains unsafe path characters ('${value}')`)
	return name
}

async function captureStableStrip(page, url, opts) {
	await page.goto(url, { waitUntil: 'load', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined, { timeout: opts.timeoutMs })
	await page.evaluate(({ snap, focus }) => {
		const app = globalThis.steelseed
		const cameraSystem = app.registry.peek('camera')
		const render = app.registry.peek('render')
		const terrain = app.registry.peek('terrain')
		if (cameraSystem == null || render == null || terrain == null)
			throw new Error('clip visual pass requires camera, render, and terrain systems')
		if (snap) {
			const advance = app.clock.frame.bind(app.clock)
			app.clock.frame = atMs => {
				const dt = advance(atMs)
				app.clock.time.alpha = 1
				return dt
			}
		}
		const frameMs = 1000 / 60
		let renderedFrames = 0
		const renderNext = () => app.renderOneFrame(renderedFrames++ * frameMs)
		renderNext()
		const world = app.ctx.snapshot?.world
		if (world == null) throw new Error('moving fixture produced no world section')
		let targetX = (world.boundsLeft + world.boundsRight) * 0.5
		let targetZ = (world.boundsTop + world.boundsBottom) * 0.5
		if (focus === 'turret') {
			const actors = app.ctx.snapshot?.actors
			if (actors == null) throw new Error('turret focus requires an actors section')
			let leader = -1
			for (let i = 0; i < actors.count; i++) if (actors.id[i] === 1) { leader = i; break }
			if (leader < 0) throw new Error('turret focus actor 1 is missing')
			targetX = actors.posX[leader] / 1024
			targetZ = actors.posY[leader] / 1024
		}
		const targetY = terrain.heightAt(targetX, targetZ)
		const cameraHeight = focus === 'turret' ? 9 : 32
		cameraSystem.target.set([targetX, targetY, targetZ])
		cameraSystem.targetGoal.set([targetX, targetY, targetZ])
		cameraSystem.height = cameraHeight
		cameraSystem.heightGoal = cameraHeight
		cameraSystem.yaw = 0.55
		cameraSystem.yawGoal = 0.55
		cameraSystem.boundsKnown = true
		cameraSystem.boundsMinX = world.boundsLeft
		cameraSystem.boundsMaxX = world.boundsRight
		cameraSystem.boundsMinZ = world.boundsTop
		cameraSystem.boundsMaxZ = world.boundsBottom
		renderNext()
		while (app.ctx.prevSnapshot == null && renderedFrames < 12) renderNext()
		if (app.ctx.prevSnapshot == null)
			throw new Error('prevSnapshot stayed null through visual warm-up')
		document.getElementById('boot')?.setAttribute('hidden', '')
		globalThis.__clipVisualStep = () => {
			renderNext()
			if (focus !== 'turret') return null
			const actors = app.ctx.snapshot?.actors
			const units = app.registry.peek('units')
			if (actors == null || units == null) return null
			let leader = -1
			for (let i = 0; i < actors.count; i++) if (actors.id[i] === 1) { leader = i; break }
			if (leader < 0) return null
			const slotName = app.ctx.actorTypeName(actors.typeId[leader])
			const bucket = units.slotBuckets.get(slotName)
			if (bucket == null || bucket.count === 0) return null
			const x = bucket.instances[12]
			const y = bucket.instances[13]
			const z = bucket.instances[14]
			const m = render.camera.viewProj
			const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
			const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
			const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
			if (Math.abs(cw) < 1e-9) return null
			return [(cx / cw * 0.5 + 0.5) * innerWidth, (0.5 - cy / cw * 0.5) * innerHeight]
		}
	}, { snap: opts.falsifySnap, focus: opts.focus })

	const canvas = page.locator('#viewport')
	const rgba = Buffer.alloc(opts.tileWidth * opts.frames * opts.tileHeight * 4)
	for (let frame = 0; frame < opts.frames; frame++) {
		const cropCentre = await page.evaluate(() => globalThis.__clipVisualStep())
		const source = decodePng(await canvas.screenshot({ type: 'png', animations: 'disabled' }))
		for (let y = 0; y < opts.tileHeight; y++) {
			const sy = cropCentre == null
				? Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / opts.tileHeight))
				: Math.min(source.height - 1, Math.max(0, Math.floor(cropCentre[1] - opts.tileHeight * 0.5 + y)))
			for (let x = 0; x < opts.tileWidth; x++) {
				const sx = cropCentre == null
					? Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / opts.tileWidth))
					: Math.min(source.width - 1, Math.max(0, Math.floor(cropCentre[0] - opts.tileWidth * 0.5 + x)))
				const src = (sy * source.width + sx) * 4
				const dst = (y * opts.tileWidth * opts.frames + frame * opts.tileWidth + x) * 4
				rgba[dst] = source.data[src]
				rgba[dst + 1] = source.data[src + 1]
				rgba[dst + 2] = source.data[src + 2]
				rgba[dst + 3] = source.data[src + 3]
			}
		}
	}
	let maxChannel = 0
	const buckets = new Set()
	const stripWidth = opts.tileWidth * opts.frames
	for (let sy = 0; sy < 64; sy++) {
		const y = Math.min(opts.tileHeight - 1, Math.floor((sy + 0.5) * opts.tileHeight / 64))
		for (let sx = 0; sx < 64; sx++) {
			const x = Math.min(stripWidth - 1, Math.floor((sx + 0.5) * stripWidth / 64))
			const offset = (y * stripWidth + x) * 4
			const r = rgba[offset]
			const g = rgba[offset + 1]
			const b = rgba[offset + 2]
			maxChannel = Math.max(maxChannel, r, g, b)
			buckets.add(`${r >> 4},${g >> 4},${b >> 4}`)
		}
	}
	return {
		png: encodePng(stripWidth, opts.tileHeight, rgba),
		pixelProbe: { maxChannel, colourBuckets: buckets.size },
	}
}

async function launchBrowser() {
	const options = {
		headless: true,
		args: [
			'--use-angle=metal',
			'--enable-unsafe-webgpu',
			'--enable-features=Vulkan,UseSkiaRenderer',
			'--ignore-gpu-blocklist',
			'--enable-gpu-rasterization',
			'--disable-gpu-sandbox',
		],
	}
	try {
		return await chromium.launch(options)
	} catch (error) {
		if (!/Executable doesn't exist|please run|install/i.test(String(error.message))) throw error
		console.warn("clip: Playwright Chromium is absent; using installed Chrome (pixel output may differ)")
		return chromium.launch({ ...options, channel: 'chrome' })
	}
}

async function waitForServer(url, timeout, child) {
	const deadline = Date.now() + timeout
	while (Date.now() < deadline) {
		if (child.exitCode != null || child.signalCode != null)
			throw new Error(`preview exited early (code=${child.exitCode}, signal=${child.signalCode})`)
		try {
			const response = await fetch(url, {
				method: 'GET',
				cache: 'no-store',
				signal: AbortSignal.timeout(1000),
			})
			await response.body?.cancel()
			if (response.ok) return
		} catch {
			// Server is still starting.
		}
		await new Promise(resolveWait => setTimeout(resolveWait, 100))
	}
	throw new Error(`preview did not come up at ${url} within ${timeout}ms; run npm run build first`)
}
