#!/usr/bin/env node
// STEELSEED — tools/composedgate
// Proves the generated OpenRA WASM host and generated Vite presentation share one document.
// `--falsify=zero` removes the host module from the served composition and must go red.
// --url=http://localhost:8790/steelseed/index.html checks an existing server without restarting it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const TOOL = 'composedgate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME_ROOT = resolve(WEB_ROOT, '..')
const ENGINE_ROOT = join(GAME_ROOT, 'engine')
const APP_BUNDLE = join(ENGINE_ROOT, 'bin-browser', 'AppBundle')
const SERVER_SCRIPT = join(ENGINE_ROOT, 'OpenRA.Browser', 'tests', 'server.mjs')
const EXPECTED_MAPS = JSON.parse(readFileSync(join(ENGINE_ROOT,
	'steelseed-host', 'generated', 'mods', 'ra', 'map-catalog.json'), 'utf8')).length
const SHOTS = join(WEB_ROOT, 'shots')
const flags = new Map(process.argv.slice(2).map(arg => {
	const [key, ...rest] = arg.replace(/^--/, '').split('=')
	return [key, rest.length > 0 ? rest.join('=') : '1']
}))
const falsify = flags.get('falsify') ?? 'none'
if (falsify !== 'none' && falsify !== 'zero') throw new Error(`${TOOL}: unknown --falsify=${falsify}`)
const port = Number(flags.get('port') ?? 8415)
if (!Number.isSafeInteger(port) || port <= 0) throw new Error(`${TOOL}: invalid --port`)
const requestedSpawnId = flags.has('spawn') ? Number(flags.get('spawn')) : null
if (requestedSpawnId !== null && (!Number.isSafeInteger(requestedSpawnId) || requestedSpawnId <= 0))
	throw new Error(`${TOOL}: invalid --spawn`)

const suppliedUrl = flags.get('url') ?? null
const baseUrl = suppliedUrl ?? `http://127.0.0.1:${port}/steelseed/index.html`
const server = suppliedUrl ? null : spawnProcessGroup(process.execPath, [
	SERVER_SCRIPT,
	'--root', APP_BUNDLE,
	'--port', String(port),
], { cwd: ENGINE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
let browser = null
let exitCode = 0

try {
	await waitForServer(baseUrl, 30000)
	const chromium = await loadChromium(TOOL)
	const launched = await launchGpuBrowser(chromium, TOOL)
	browser = launched.browser
	if (launched.warning) console.warn(launched.warning)
	const page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
	const errors = []
	page.on('pageerror', error => errors.push(error.message))
	page.on('console', message => {
		if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text())) errors.push(message.text())
	})
	// The bundle names the production account origin while this gate serves it on
	// loopback, where production CORS refuses it. Account sign-in is tested by the
	// landing gates; the engine/presentation seam must not depend on production CORS
	// or the network, so /api/me answers as production does for a signed-out visitor.
	await page.route('**/api/me', route => route.fulfill({
		status: 200,
		contentType: 'application/json',
		headers: {
			'access-control-allow-origin': new URL(baseUrl).origin,
			'access-control-allow-credentials': 'true',
		},
		body: '{"user":null}',
	}))
	if (falsify === 'zero') {
		await page.route('**/steelseed/index.html*', async route => {
			const response = await route.fetch()
			const body = (await response.text()).replace('<script type="module" src="../main.js"></script>', '')
			await route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/html; charset=utf-8' } })
		})
	}

	const url = new URL(baseUrl)
	url.searchParams.set('mode', 'game')
	url.searchParams.set('platform', 'null')
	url.searchParams.set('Debug.ServerRandomSeed', '104729')
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed !== undefined &&
		// The presentation global can register while the host module is still awaiting
		// dotnet boot; probing the seam before `ora`/`steelseedBridge` exist reads
		// pre-boot values and races the engine. Await full host readiness too.
		globalThis.ora !== undefined && globalThis.steelseedBridge !== undefined,
		undefined, { timeout: 120000, polling: 100 })
	const surface = await page.evaluate(async () => ({
		session: globalThis.steelseed.ctx.session.available,
		host: typeof globalThis.ora?.GetSkirmishCatalog,
		bridge: typeof globalThis.steelseedBridge?.pollSnapshot,
		catalog: (await globalThis.steelseedBridge?.getSkirmishCatalog?.())?.maps?.length ?? 0,
		setup: document.getElementById('session-ui').hidden === false,
	}))
	// The generated mod is the authority for the current playable catalog.
	if (!surface.session || surface.host !== 'function' || surface.bridge !== 'function' ||
		surface.catalog !== EXPECTED_MAPS || !surface.setup)
		throw new Error(`composition seam missing: ${JSON.stringify(surface)}`)

	// Make the real-runtime witness exercise the worst normal camera case. Random spawns
	// previously let the test miss that map-edge bases could appear on the minimap while
	// remaining outside the playable camera frustum.
	const selectedSpawn = await page.evaluate(async requestedId => {
		const catalog = await globalThis.steelseedBridge.getSkirmishCatalog()
		const mapUid = document.getElementById('session-map').value
		const map = catalog.maps.find(candidate => candidate.uid === mapUid)
		if (!map || map.spawnPoints.length === 0) throw new Error('selected map has no spawn points')
		const centreX = map.bounds.x + map.bounds.width * .5
		const centreY = map.bounds.y + map.bounds.height * .5
		const spawn = requestedId === null ? map.spawnPoints.reduce((furthest, candidate) => {
			const distance = (candidate.x - centreX) ** 2 + (candidate.y - centreY) ** 2
			const best = (furthest.x - centreX) ** 2 + (furthest.y - centreY) ** 2
			return distance > best ? candidate : furthest
		}) : map.spawnPoints.find(candidate => candidate.id === requestedId)
		if (!spawn) throw new Error(`requested spawn ${requestedId} is unavailable`)
		const human = [...document.querySelectorAll('[data-slot-id]')]
			.find(row => row.querySelector('select[data-field="kind"]')?.value === 'human')
		const input = human?.querySelector('select[data-field="spawn"]')
		if (!input || input.disabled) throw new Error('human spawn selector is unavailable')
		input.value = String(spawn.id)
		return { map: mapUid, ...spawn }
	}, requestedSpawnId)

	await page.click('#session-start')
	try {
		await page.waitForFunction(() => {
			const app = globalThis.steelseed
			return app.ctx.snapshot?.actors?.count > 0 &&
				app.ctx.snapshot?.players?.length > 0 &&
				document.getElementById('game-ui').hidden === false &&
				document.getElementById('session-ui').hidden
		}, undefined, { timeout: 120000, polling: 100 })
	} catch (error) {
		const diagnosis = await page.evaluate(() => ({
			setupState: document.getElementById('session-ui')?.dataset.state,
			setupStatus: document.getElementById('session-status')?.textContent,
			host: globalThis.ora?.HostStatus?.(),
			session: globalThis.steelseedBridge?.getSessionStatus?.(),
			tick: globalThis.steelseed?.ctx.snapshot?.tick,
			actors: globalThis.steelseed?.ctx.snapshot?.actors?.count,
			players: globalThis.steelseed?.ctx.snapshot?.players?.length,
		}))
		throw new Error(`${error.message}; ${JSON.stringify(diagnosis)}`)
	}

	const overviewBefore = await page.evaluate(() => {
		const app = globalThis.steelseed
		app.renderOneFrame(performance.now())
		const snap = app.ctx.snapshot
		const camera = app.ctx.get('camera')
		const ui = app.ctx.get('ui')
		const minimap = document.getElementById('hud-minimap')
		const rect = minimap.getBoundingClientRect()
		let actor = null
		for (let i = 0; i < snap.actors.count; i++) {
			if (snap.actors.owner[i] !== snap.world.renderPlayer) continue
			actor = {
				id: snap.actors.id[i],
				x: snap.actors.posX[i] / 1024,
				z: snap.actors.posY[i] / 1024,
			}
			break
		}
		if (!actor) throw new Error('no local actor available for strategic-overview witness')
		const y = app.ctx.get('terrain').heightAt(actor.x, actor.z) + .6
		const vp = app.ctx.get('render').camera.viewProj
		const cw = vp[3] * actor.x + vp[7] * y + vp[11] * actor.z + vp[15]
		const cx = (vp[0] * actor.x + vp[4] * y + vp[8] * actor.z + vp[12]) / cw
		const cy = (vp[1] * actor.x + vp[5] * y + vp[9] * actor.z + vp[13]) / cw
		return {
			actor,
			actorScreen: {
				x: (cx * .5 + .5) * app.ctx.canvas.clientWidth,
				y: (.5 - cy * .5) * app.ctx.canvas.clientHeight,
			},
			viewport: [app.ctx.canvas.clientWidth, app.ctx.canvas.clientHeight],
			selection: [...ui.selection],
			marker: {
				x: (actor.x - snap.world.boundsLeft) * rect.width /
					(snap.world.boundsRight - snap.world.boundsLeft),
				y: (actor.z - snap.world.boundsTop) * rect.height /
					(snap.world.boundsBottom - snap.world.boundsTop),
			},
			away: {
				x: actor.x - snap.world.boundsLeft < (snap.world.boundsRight - snap.world.boundsLeft) * .5 ?
					rect.width - 8 : 8,
				y: actor.z - snap.world.boundsTop < (snap.world.boundsBottom - snap.world.boundsTop) * .5 ?
					rect.height - 8 : 8,
			},
			world: { ...snap.world },
			focusCommands: ui.strategicStats.focusCommands,
			camera: {
				target: Array.from(camera.target),
				targetGoal: Array.from(camera.targetGoal),
				eye: Array.from(camera.eye),
				height: camera.height,
				yaw: camera.yaw,
				bounds: [camera.boundsMinX, camera.boundsMinZ, camera.boundsMaxX, camera.boundsMaxZ],
			},
		}
	})
	const [initialWidth, initialHeight] = overviewBefore.viewport
	if (overviewBefore.actorScreen.x < initialWidth * .1 || overviewBefore.actorScreen.x > initialWidth * .9 ||
		overviewBefore.actorScreen.y < initialHeight * .1 || overviewBefore.actorScreen.y > initialHeight * .9)
		throw new Error(`match opened away from local base: ${JSON.stringify(overviewBefore.actorScreen)}`)
	if (!overviewBefore.selection.includes(overviewBefore.actor.id))
		throw new Error(`local base ${overviewBefore.actor.id} was not selected on match start`)
	await page.locator('#hud-minimap').click({ position: overviewBefore.away })
	await page.waitForFunction(before => globalThis.steelseed.ctx.get('ui').strategicStats.focusCommands > before,
		overviewBefore.focusCommands, { timeout: 5000, polling: 50 })
	await page.waitForTimeout(250)
	const overviewAway = await page.evaluate(actor => {
		const camera = globalThis.steelseed.ctx.get('camera')
		return {
			focusCommands: globalThis.steelseed.ctx.get('ui').strategicStats.focusCommands,
			distance: Math.hypot(camera.targetGoal[0] - actor.x, camera.targetGoal[2] - actor.z),
		}
	}, overviewBefore.actor)
	const minimumAwayDistance = Math.max(8,
		Math.min(overviewBefore.world.boundsRight - overviewBefore.world.boundsLeft,
			overviewBefore.world.boundsBottom - overviewBefore.world.boundsTop) * .15)
	if (overviewAway.distance < minimumAwayDistance)
		throw new Error(`strategic overview did not move away from base: ${JSON.stringify(overviewAway)}`)
	await page.locator('#hud-minimap').click({ position: overviewBefore.marker })
	await page.waitForFunction(before => globalThis.steelseed.ctx.get('ui').strategicStats.focusCommands > before,
		overviewAway.focusCommands, { timeout: 5000, polling: 50 })
	await page.waitForFunction(() => {
		const app = globalThis.steelseed
		const camera = app.ctx.get('camera')
		const ground = app.ctx.get('terrain').heightAt(camera.target[0], camera.target[2])
		const dx = camera.targetGoal[0] - camera.target[0]
		const dz = camera.targetGoal[2] - camera.target[2]
		// A minimap jump snaps X/Z, but focus ground height, zoom and orientation
		// can still ease. Projecting a click before those settle makes the screen
		// coordinate stale by the time a slow CI runner delivers its pointer event.
		return Math.hypot(dx, dz) < 0.05 &&
			Math.abs(camera.target[1] - ground) < 0.02 &&
			Math.abs(camera.height - camera.heightGoal) < 0.02 &&
			Math.abs(camera.yawRaw - camera.yawGoal) < 0.001 &&
			Math.abs(camera.tilt - camera.tiltGoal) < 0.001
	}, undefined, { timeout: 5000, polling: 50 })
	const overviewAfter = await page.evaluate(() => {
		const app = globalThis.steelseed
		app.renderOneFrame(performance.now())
		const camera = app.ctx.get('camera')
		const terrain = app.ctx.get('terrain')
		const snap = app.ctx.snapshot
		let actorIndex = -1
		for (let i = 0; i < snap.actors.count; i++)
			if (snap.actors.owner[i] === snap.world.renderPlayer) {
				actorIndex = i
				break
			}
		if (actorIndex < 0) throw new Error('local actor disappeared after overview focus')
		const x = snap.actors.posX[actorIndex] / 1024
		const z = snap.actors.posY[actorIndex] / 1024
		const y = app.ctx.get('terrain').heightAt(x, z) + .6
		const vp = app.ctx.get('render').camera.viewProj
		const transform = new Float32Array(16)
		const visual = { mesh: null, surfaceSet: '', playerColor: 0 }
		const captured = app.ctx.get('units').captureActorVisual(snap.actors.id[actorIndex], transform, 0, visual)
		const mesh = visual.mesh
		let drawnCentre = null
		if (captured && mesh) {
			const mx = (mesh.aabbMin[0] + mesh.aabbMax[0]) * .5
			const my = (mesh.aabbMin[1] + mesh.aabbMax[1]) * .5
			const mz = (mesh.aabbMin[2] + mesh.aabbMax[2]) * .5
			const wx = transform[0] * mx + transform[4] * my + transform[8] * mz + transform[12]
			const wy = transform[1] * mx + transform[5] * my + transform[9] * mz + transform[13]
			const wz = transform[2] * mx + transform[6] * my + transform[10] * mz + transform[14]
			const ww = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15]
			drawnCentre = {
				x: ((vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / ww * .5 + .5) * app.ctx.canvas.clientWidth,
				y: (.5 - (vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / ww * .5) * app.ctx.canvas.clientHeight,
				world: [wx, wy, wz], source: 'drawn-mesh',
			}
		} else {
			// The game's picker uses this same metadata fallback when a mesh bucket is
			// briefly unavailable. A terrain sample is not the actor's authored height.
			const wy = snap.actors.posZ[actorIndex] / 1024 +
				app.ctx.get('units').selectionHeightM(snap.actors.typeId[actorIndex]) * .5
			const ww = vp[3] * x + vp[7] * wy + vp[11] * z + vp[15]
			drawnCentre = {
				x: ((vp[0] * x + vp[4] * wy + vp[8] * z + vp[12]) / ww * .5 + .5) * app.ctx.canvas.clientWidth,
				y: (.5 - (vp[1] * x + vp[5] * wy + vp[9] * z + vp[13]) / ww * .5) * app.ctx.canvas.clientHeight,
				world: [x, wy, z], source: 'selection-metadata',
			}
		}
		const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
		const cx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw
		const cy = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw
		const flatCorner = (screenX, screenY) => {
			camera.picker.setRay(camera.view, camera.proj, camera.eye, screenX, screenY,
				app.ctx.canvas.clientWidth, app.ctx.canvas.clientHeight)
			const origin = camera.picker.origin
			const direction = camera.picker.direction
			const distance = -origin[1] / direction[1]
			return {
				x: origin[0] + direction[0] * distance,
				z: origin[2] + direction[2] * distance,
			}
		}
		return {
			focusCommands: app.ctx.get('ui').strategicStats.focusCommands,
			target: Array.from(camera.target),
			targetGoal: Array.from(camera.targetGoal),
			actorId: snap.actors.id[actorIndex],
			drawnCentre,
			actorScreen: {
				x: (cx * .5 + .5) * app.ctx.canvas.clientWidth,
				y: (.5 - cy * .5) * app.ctx.canvas.clientHeight,
			},
			viewport: [app.ctx.canvas.clientWidth, app.ctx.canvas.clientHeight],
			cornerCells: [[0, 0], [app.ctx.canvas.clientWidth, 0],
				[0, app.ctx.canvas.clientHeight], [app.ctx.canvas.clientWidth, app.ctx.canvas.clientHeight]]
				.map(([screenX, screenY]) => camera.pickGroundCell(screenX, screenY, app.ctx)),
			flatCorners: [[0, 0], [app.ctx.canvas.clientWidth, 0],
				[0, app.ctx.canvas.clientHeight], [app.ctx.canvas.clientWidth, app.ctx.canvas.clientHeight]]
				.map(([screenX, screenY]) => flatCorner(screenX, screenY)),
			terrain: {
				grid: [terrain.originX, terrain.originY, terrain.cellsWide, terrain.cellsHigh],
				chunks: terrain.chunks.length,
				visible: terrain.visibleCount,
				budgeted: terrain.budgetedCount,
				drawBudget: terrain.drawBudget,
				triangleBudget: terrain.triangleBudget,
			},
		}
	})
	const [viewportWidth, viewportHeight] = overviewAfter.viewport
	console.log(`composedgate: pick projection snapshot=${JSON.stringify(overviewAfter.actorScreen)} drawn=${JSON.stringify(overviewAfter.drawnCentre)}`)
	if (overviewAfter.actorScreen.x < viewportWidth * .1 || overviewAfter.actorScreen.x > viewportWidth * .9 ||
		overviewAfter.actorScreen.y < viewportHeight * .1 || overviewAfter.actorScreen.y > viewportHeight * .9)
		throw new Error(`edge-spawn focus left actor outside central viewport: ${JSON.stringify(overviewAfter.actorScreen)}`)
	const world = overviewBefore.world
	// User contract: free orbit may put the eye/frustum outside the playable map.
	// The stable ground pivot, rather than a yaw-dependent frustum fit, stays in bounds.
	const pivot = overviewAfter.target
	if (pivot[0] < world.boundsLeft - .05 || pivot[0] > world.boundsRight + .05 ||
		pivot[2] < world.boundsTop - .05 || pivot[2] > world.boundsBottom + .05 ||
		overviewAfter.flatCorners.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.z)))
		throw new Error(`invalid camera pivot/projection: ${JSON.stringify(overviewAfter.target)}`)
	// The UI picks the centre of the drawn mesh (or the same metadata fallback).
	// The old gate clicked terrain.heightAt + 0.6 m: on a slower runner that point
	// can miss a tall or unsettled MCV even while the actual model is selectable.
	await page.locator('#viewport').click({ position: {
		x: overviewAfter.drawnCentre.x, y: overviewAfter.drawnCentre.y,
	} })
	await page.waitForFunction(id => globalThis.steelseed.ctx.get('ui').selection.includes(id),
		overviewAfter.actorId, { timeout: 2000, polling: 50 }).catch(() => null)
	const clickState = await page.evaluate(() => ({
		input: { ...globalThis.steelseed.ctx.input.pointer },
		uiSelection: [...globalThis.steelseed.ctx.get('ui').selection],
		cameraSelection: [...globalThis.steelseed.ctx.get('camera').selected],
		selectedLocal: globalThis.steelseed.ctx.get('ui').selection.some(id => {
			const snap = globalThis.steelseed.ctx.snapshot
			for (let i = 0; i < snap.actors.count; i++)
				if (snap.actors.id[i] === id)
					return snap.actors.owner[i] === snap.world.renderPlayer
			return false
		}),
		actors: Array.from({ length: globalThis.steelseed.ctx.snapshot.actors.count }, (_, i) => {
			const app = globalThis.steelseed
			const actors = app.ctx.snapshot.actors
			return {
				id: actors.id[i],
				type: app.ctx.actorTypeName(actors.typeId[i]),
				owner: actors.owner[i],
				x: actors.posX[i] / 1024,
				z: actors.posY[i] / 1024,
			}
		}),
	}))
	if (!clickState.selectedLocal)
		throw new Error(`no local actor was selectable after overview focus at actor ${overviewAfter.actorId}: ` +
			JSON.stringify(clickState))
	if (clickState.actors.some(actor => actor.type === 'mpspawn' || actor.type === 'waypoint'))
		throw new Error(`editor-only marker leaked into gameplay actors: ${JSON.stringify(clickState.actors)}`)

	const beforePause = await page.evaluate(() => globalThis.steelseed.ctx.snapshot.tick)
	await page.click('#hud-menu')
	await page.waitForFunction(() => (globalThis.steelseed.ctx.snapshot?.flags & (1 << 1)) !== 0, undefined, {
		timeout: 30000,
		polling: 50,
	})
	const paused = await page.evaluate(() => ({
		tick: globalThis.steelseed.ctx.snapshot.tick,
		label: document.getElementById('hud-pause').textContent,
	}))
	await page.click('#menu-resume')
	await page.waitForFunction(() => (globalThis.steelseed.ctx.snapshot?.flags & (1 << 1)) === 0, undefined, {
		timeout: 30000,
		polling: 50,
	})

	const metrics = await page.evaluate(() => {
		const app = globalThis.steelseed
		app.renderOneFrame(performance.now())
		const source = app.ctx.canvas
		const copy = document.createElement('canvas')
		copy.width = source.width
		copy.height = source.height
		const g = copy.getContext('2d')
		g.drawImage(source, 0, 0)
		const rgba = g.getImageData(0, 0, copy.width, copy.height).data
		let nonBlack = 0
		let clearPixels = 0
		let maxChannel = 0
		for (let i = 0; i < rgba.length; i += 4) {
			const value = Math.max(rgba[i], rgba[i + 1], rgba[i + 2])
			if (value > 0) nonBlack++
			// Renderer clear colour. A large count means terrain chunks were incorrectly
			// culled and the canvas is showing through instead of terrain or fog.
			if (rgba[i] >= 118 && rgba[i] <= 135 && rgba[i + 1] >= 130 && rgba[i + 1] <= 145 &&
				rgba[i + 2] >= 144 && rgba[i + 2] <= 160) clearPixels++
			if (value > maxChannel) maxChannel = value
		}
		return {
			tick: app.ctx.snapshot.tick,
			actors: app.ctx.snapshot.actors.count,
			players: app.ctx.snapshot.players.length,
			drawCalls: app.ctx.get('render').stats.drawCalls,
			nonBlack,
			clearPixels,
			total: rgba.length / 4,
			maxChannel,
		}
	})
	if (errors.length > 0) throw new Error(errors[0])
	if (paused.label !== 'Resume') throw new Error(`pause label was '${paused.label}'`)
	if (metrics.actors <= 0 || metrics.players < 2 || metrics.drawCalls <= 0)
		throw new Error(`live snapshot/render metrics invalid: ${JSON.stringify(metrics)}`)
	// Tiny black edge samples are legal under projection/canvas rounding. The exact edge
	// rasterisation varies by GPU, so tolerate at most 0.2% while still rejecting any
	// meaningful off-map band (the independent frustum gate checks the geometry numerically).
	if (metrics.nonBlack / metrics.total < .998 || metrics.maxChannel < 24)
		throw new Error(`live composed frame invalid: ${JSON.stringify(metrics)}`)
	if (metrics.clearPixels / metrics.total > .002)
		throw new Error(`off-map clear colour leaked through terrain: ${JSON.stringify(metrics)}`)

	mkdirSync(SHOTS, { recursive: true })
	const witness = await page.screenshot({ type: 'png', animations: 'disabled' })
	writeFileSync(join(SHOTS, 'composed-playable.png'), witness)
	console.log(
		`${TOOL}: edge-spawn=${selectedSpawn.id} focus=${overviewBefore.focusCommands}->${overviewAway.focusCommands}` +
		`->${overviewAfter.focusCommands} ` +
		`actor=${overviewAfter.actorId} screen=${Math.round(overviewAfter.actorScreen.x)},${Math.round(overviewAfter.actorScreen.y)} ` +
		`selected=${clickState.uiSelection.join(',')}`,
	)
	console.log(
		`${TOOL}: tick=${beforePause}->${paused.tick}->${metrics.tick} actors=${metrics.actors} players=${metrics.players} ` +
		`draws=${metrics.drawCalls} pixels=${metrics.nonBlack}/${metrics.total} clear=${metrics.clearPixels} max=${metrics.maxChannel}`,
	)
	console.log(`${TOOL}: PASS — one document starts, pauses, resumes and presents the authoritative OpenRA match`)
} catch (error) {
	console.error(`${TOOL}: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser) await browser.close()
	if (server) await stopProcessGroup(server)
}

process.exit(exitCode)

async function waitForServer(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() <= deadline) {
		if (server && server.exitCode != null) throw new Error(`server exited ${server.exitCode}`)
		try {
			const response = await fetch(url)
			if (response.ok) return
		} catch { /* retry */ }
		await new Promise(resolveWait => setTimeout(resolveWait, 100))
	}
	throw new Error(`server did not start within ${timeoutMs}ms`)
}
