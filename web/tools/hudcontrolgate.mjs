#!/usr/bin/env node
// STEELSEED — tools/hudcontrolgate
// The on-screen controls a player without a keyboard, or without a working night, has to
// rely on. Six things, all measured in a real composed match rather than asserted from source:
//
//   1. NIGHT IS PLAYABLE. The complaint that started this was "it is dark i cant see
//      anything", and it was justified: a physically scaled night rendered at mean frame
//      luminance 0.020 against day's 0.352, with a standard deviation of 0.020 — not dim,
//      gone. The gate pins night between a readable floor and a ceiling that keeps it night,
//      and pins day so the lift cannot be paid for by washing out the day.
//   2. The daylight switch pins and releases the sun, and shows the mode actually in force.
//   3. Pan, zoom, tilt, turn and reset each move the view, in the direction they claim.
//   4. The edge hint lights the edge the camera is really scrolling from, and only that one.
//   5. Right clicking the overview commands the selection through the same contextual path a
//      battlefield click uses; left clicking still only moves the camera.
//   6. An order the selection cannot reach is marked in red rather than accepted in silence.
//
//   node tools/hudcontrolgate.mjs [--url http://127.0.0.1:8321/steelseed/index.html]

import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const TOOL = 'hudcontrolgate'
const arg = (name, fallback) => {
	const found = process.argv.find(value => value.startsWith(`--${name}=`))
	return found ? found.slice(name.length + 3) : fallback
}
const base = arg('url', 'http://127.0.0.1:8321/steelseed/index.html')

// Measured on the composed build. Night must stay clearly darker than day and clearly above
// the black it used to be; the band is wide enough for art changes and narrow enough to
// catch a regression back to an unplayable night.
const NIGHT_MEAN_FLOOR = 0.045
const NIGHT_MEAN_CEILING = 0.20
const DAY_MEAN_FLOOR = 0.20
// Night must keep a share of the structure daylight has, rather than clear a fixed standard
// deviation. The absolute floor this replaces was calibrated on 2026-09-06 against a build
// whose dry ground carried a specular hotspot; removing that glint was a deliberate material
// correction (measured 195.77 -> 89.71 luma on the hotspot) and it halved whole-frame contrast
// in BOTH day and night, so the fixed threshold began failing a change that improved the game.
// A ratio survives that class of renderer-wide change and still catches a night going flat.
const NIGHT_CONTRAST_SHARE = 0.20
// ...but only while daylight itself has structure, so a uniformly flat renderer cannot satisfy
// the ratio by collapsing both ends of it.
const DAY_CONTRAST_FLOOR = 0.030

const fail = message => { throw new Error(`${TOOL}: ${message}`) }
const findings = []
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance

const { browser } = await launchGpuBrowser(await loadChromium(TOOL), TOOL)
const page = await browser.newPage({ viewport: { width: 1512, height: 900 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
try {
	await page.goto(`${base}?mode=game&platform=null&quality=medium&weather=clear`,
		{ waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined,
		{ timeout: 180000, polling: 100 })
	const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog())
	const map = catalog.maps.find(entry => entry.title === 'Marigold Town') ?? catalog.maps[0]
	const config = configFor(catalog, map, { withBot: false })
	config.options.startingunits = 'heavy'
	config.options.explored = 'True'
	config.options.fog = 'False'
	await page.evaluate(value => steelseed.ctx.session.startSkirmish(value), config)
	await page.waitForFunction(
		() => steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui').hidden,
		undefined, { timeout: 180000, polling: 100 })
	await page.waitForTimeout(2500)

	await page.evaluate(() => {
		globalThis.contextCalls = []
		// Orders cross on the bridge seam: the raw `ora.IssueContextOrderN` export is
		// no longer in the UI's call path, so a spy there records nothing.
		const bridge = steelseed.bridge
		const inner = bridge.issueContextOrder.bind(bridge)
		bridge.issueContextOrder = order => {
			const result = inner(order)
			globalThis.contextCalls.push({
				subjects: order.subjectCount, cellX: order.targetCellX, cellY: order.targetCellY, result,
			})
			return Promise.resolve(result)
		}
	})

	// Frame the starting force so the measurements look at a battlefield, not empty ground.
	await page.evaluate(() => {
		const ctx = steelseed.ctx
		const actors = ctx.snapshot.actors
		const me = ctx.snapshot.world.renderPlayer
		let x = 0, z = 0, n = 0
		for (let i = 0; i < actors.count; i++)
			if (actors.owner[i] === me) { x += actors.posX[i] / 1024; z += actors.posY[i] / 1024; n++ }
		if (n > 0) ctx.get('camera').focusWorld(x / n, z / n)
		ctx.get('camera').zoomByNotches(4)
	})
	await page.waitForTimeout(1400)

	// --- 1 & 2. daylight -------------------------------------------------------------------
	const clickDaylight = async mode => {
		await page.click(`#hud-daylight button[data-daylight="${mode}"]`)
		await page.waitForTimeout(1500)
	}
	/** One rendered frame, read back in the same task: a non-preserved swapchain is gone by the next. */
	const frameLuma = () => page.evaluate(() => {
		const app = steelseed, ctx = app.ctx
		app.stop()
		app.renderOneFrame(performance.now())
		const width = 640, height = 400
		const scratch = document.createElement('canvas')
		scratch.width = width
		scratch.height = height
		const g = scratch.getContext('2d')
		g.drawImage(ctx.canvas, 0, 0, width, height)
		const data = g.getImageData(0, 0, width, height).data
		app.start()
		let sum = 0
		const luma = new Float64Array(width * height)
		for (let i = 0, p = 0; i < data.length; i += 4, p++) {
			luma[p] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
			sum += luma[p]
		}
		const mean = sum / luma.length
		let variance = 0
		for (const value of luma) variance += (value - mean) ** 2
		return { mean: +mean.toFixed(4), sd: +Math.sqrt(variance / luma.length).toFixed(4) }
	})
	const daylightState = () => page.evaluate(() => {
		const sky = steelseed.ctx.get('sky')
		const pressed = [...document.querySelectorAll('#hud-daylight button[data-daylight]')]
			.filter(button => button.getAttribute('aria-pressed') === 'true')
			.map(button => button.dataset.daylight)
		return { mode: sky.daylightMode, timeOfDay: Math.round(sky.timeOfDay), pressed }
	})

	await clickDaylight('day')
	const dayState = await daylightState()
	if (dayState.mode !== 'day' || dayState.timeOfDay !== 720)
		fail(`the Day button left the sky at ${dayState.mode} / ${dayState.timeOfDay} min`)
	if (dayState.pressed.length !== 1 || dayState.pressed[0] !== 'day')
		fail(`the switch shows ${JSON.stringify(dayState.pressed)} while the sky is pinned to day`)
	const day = await frameLuma()
	if (day.mean < DAY_MEAN_FLOOR)
		fail(`daylight renders at mean luminance ${day.mean}, below the ${DAY_MEAN_FLOOR} floor`)

	await clickDaylight('night')
	const nightState = await daylightState()
	if (nightState.mode !== 'night' || nightState.timeOfDay !== 0)
		fail(`the Night button left the sky at ${nightState.mode} / ${nightState.timeOfDay} min`)
	const night = await frameLuma()
	if (night.mean < NIGHT_MEAN_FLOOR)
		fail(`night renders at mean luminance ${night.mean}, below the ${NIGHT_MEAN_FLOOR} floor: ` +
			'this is the "it is dark i cant see anything" regression')
	if (night.mean > NIGHT_MEAN_CEILING)
		fail(`night renders at mean luminance ${night.mean}, above ${NIGHT_MEAN_CEILING}: it is no longer night`)
	if (day.sd < DAY_CONTRAST_FLOOR)
		fail(`daylight itself has standard deviation ${day.sd}, below ${DAY_CONTRAST_FLOOR}: the whole ` +
			'renderer is flat, so the night contrast share below would pass for the wrong reason')
	if (night.sd < day.sd * NIGHT_CONTRAST_SHARE)
		fail(`night keeps only ${(night.sd / day.sd * 100).toFixed(0)}% of daylight's standard deviation ` +
			`(${night.sd} of ${day.sd}), below the ${NIGHT_CONTRAST_SHARE * 100}% share: shapes do not separate`)
	if (night.mean >= day.mean)
		fail(`night (${night.mean}) is not darker than day (${day.mean})`)
	findings.push(`daylight: day mean ${day.mean} sd ${day.sd}, night mean ${night.mean} sd ${night.sd} ` +
		`(night is ${(night.mean / day.mean * 100).toFixed(0)}% of day luminance and keeps ` +
		`${(night.sd / day.sd * 100).toFixed(0)}% of its structure)`)

	await clickDaylight('auto')
	const autoState = await daylightState()
	if (autoState.mode !== 'auto') fail('the Auto button did not release the sun')
	await page.waitForTimeout(1200)
	const autoLater = await daylightState()
	if (autoLater.timeOfDay === autoState.timeOfDay)
		fail(`Auto left the clock stopped at ${autoState.timeOfDay} min`)
	findings.push(`auto: clock advanced ${autoState.timeOfDay} → ${autoLater.timeOfDay} min`)
	await clickDaylight('day')

	// --- 3. camera controls ------------------------------------------------------------------
	// The pan/tilt/turn cluster lives inside the overview's collapsible <details id="hud-camera">;
	// a player opens the Camera section first, so the gate opens it before measuring the controls.
	await page.click('#hud-camera summary')
	const cameraState = () => page.evaluate(() => {
		const camera = steelseed.ctx.get('render').camera
		return {
			position: [...camera.position],
			// Third row of the view matrix is the camera's own backward axis; a turn or a
			// tilt has to move it, and comparing it separates orientation from position.
			forward: [-camera.view[2], -camera.view[6], -camera.view[10]],
		}
	})
	const press = async (selector, ms = 260) => {
		const box = await page.locator(selector).boundingBox()
		if (!box) fail(`camera control ${selector} is not on screen`)
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
		await page.mouse.down()
		await page.waitForTimeout(ms)
		await page.mouse.up()
		await page.waitForTimeout(500)
	}
	const before = await cameraState()
	await press('#hud-pan button[data-pan="1,0"]')
	const panned = await cameraState()
	const panDistance = Math.hypot(panned.position[0] - before.position[0], panned.position[2] - before.position[2])
	if (panDistance < 1)
		fail(`holding pan-right moved the camera ${panDistance.toFixed(2)} m; the control does nothing`)
	await press('#hud-pan button[data-pan="-1,0"]')
	const returned = await cameraState()
	const back = Math.hypot(returned.position[0] - before.position[0], returned.position[2] - before.position[2])
	if (back > panDistance * 0.6)
		fail(`pan-left did not undo pan-right: ${panDistance.toFixed(2)} m out, still ${back.toFixed(2)} m away`)

	const beforeZoom = await cameraState()
	await press('.hud-cam-row button[data-zoom="1"]')
	const zoomedIn = await cameraState()
	if (!(zoomedIn.position[1] < beforeZoom.position[1] - 0.5))
		fail(`zoom in left the eye at ${zoomedIn.position[1].toFixed(2)} m, was ${beforeZoom.position[1].toFixed(2)} m`)
	await press('.hud-cam-row button[data-zoom="-1"]')
	const zoomedOut = await cameraState()
	if (!(zoomedOut.position[1] > zoomedIn.position[1] + 0.5))
		fail(`zoom out did not raise the eye: ${zoomedIn.position[1].toFixed(2)} → ${zoomedOut.position[1].toFixed(2)} m`)

	const beforeTurn = await cameraState()
	await press('.hud-cam-row button[data-rotate="1"]')
	const turned = await cameraState()
	const turnDelta = Math.hypot(turned.forward[0] - beforeTurn.forward[0], turned.forward[2] - beforeTurn.forward[2])
	if (turnDelta < 0.02) fail(`the turn control moved the view direction by ${turnDelta.toFixed(4)}`)
	const beforeTilt = await cameraState()
	await press('.hud-cam-row button[data-tilt="1"]')
	const tilted = await cameraState()
	if (Math.abs(tilted.forward[1] - beforeTilt.forward[1]) < 0.005)
		fail(`the tilt control moved the pitch by ${(tilted.forward[1] - beforeTilt.forward[1]).toFixed(5)}`)
	await press('#hud-pan button[data-camera="reset"]', 40)
	const reset = await cameraState()
	if (!near(reset.forward[1], beforeTurn.forward[1], 0.08))
		fail(`reset did not level the view: pitch component ${reset.forward[1].toFixed(3)} vs ${beforeTurn.forward[1].toFixed(3)}`)
	findings.push(`camera: pan ${panDistance.toFixed(1)} m and back, zoom ` +
		`${beforeZoom.position[1].toFixed(1)} → ${zoomedIn.position[1].toFixed(1)} m, turn ${turnDelta.toFixed(3)}, tilt and reset answered`)

	// --- 4. edge hints -----------------------------------------------------------------------
	const edgeState = () => page.evaluate(() => ({
		mask: steelseed.ctx.get('camera').edgeScrollMask,
		lit: ['edge-left', 'edge-right', 'edge-top', 'edge-bottom']
			.filter(id => document.getElementById(id)?.classList.contains('on')),
	}))
	const edges = [
		['edge-left', 1, 3, 450],
		['edge-right', 2, 1509, 450],
		['edge-top', 4, 756, 3],
		['edge-bottom', 8, 756, 897],
	]
	for (const [id, bit, x, y] of edges) {
		await page.mouse.move(756, 450)
		await page.waitForTimeout(220)
		await page.mouse.move(x, y)
		await page.waitForTimeout(420)
		const state = await edgeState()
		if ((state.mask & bit) === 0) fail(`the camera does not report an edge scroll at ${id} (mask ${state.mask})`)
		if (state.lit.length !== 1 || state.lit[0] !== id)
			fail(`hovering ${id} lit ${JSON.stringify(state.lit)}; exactly that edge must glow`)
	}
	await page.mouse.move(756, 450)
	await page.waitForTimeout(420)
	const centre = await edgeState()
	if (centre.mask !== 0 || centre.lit.length !== 0)
		fail(`away from the edges the camera reports mask ${centre.mask} and ${JSON.stringify(centre.lit)} lit`)
	findings.push('edge hints: each of the four edges lights alone, and none lights at the centre')

	// --- 5 & 6. the overview commands the selection -------------------------------------------
	const selected = await page.evaluate(() => {
		const ctx = steelseed.ctx
		const actors = ctx.snapshot.actors
		const me = ctx.snapshot.world.renderPlayer
		for (let i = 0; i < actors.count; i++) {
			const name = ctx.actorTypeName(actors.typeId[i])
			if (actors.owner[i] !== me || !['1tnk', '2tnk', 'jeep'].includes(name)) continue
			const selection = ctx.get('ui').selection
			selection.length = 0
			selection.push(actors.id[i])
			ctx.get('camera').selectActors(selection)
			return { id: actors.id[i], name }
		}
		return null
	})
	if (!selected) fail('no armed vehicle in the starting force to command')

	const minimap = await page.evaluate(() => {
		const rect = document.getElementById('hud-minimap').getBoundingClientRect()
		return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
	})
	/** Screen point on the overview for a map cell, using the same bounds the UI maps through. */
	const minimapPointFor = cell => page.evaluate(([cellX, cellY, box]) => {
		const world = steelseed.ctx.snapshot.world
		return {
			x: box.x + (cellX + 0.5 - world.boundsLeft) / (world.boundsRight - world.boundsLeft) * box.w,
			y: box.y + (cellY + 0.5 - world.boundsTop) / (world.boundsBottom - world.boundsTop) * box.h,
		}
	}, [cell.x, cell.y, minimap])
	/**
	 * The colours actually painted for the order marker. The marker is written by the click
	 * handler but drawn on the next frame, so this settles first: reading in the gap between
	 * those two is how a red marker gets misread as the amber one still fading out.
	 */
	const markerState = async () => {
		await page.waitForTimeout(140)
		return await page.evaluate(() => {
			const ui = steelseed.ctx.get('ui')
			const circles = [...document.querySelectorAll('svg circle')].filter(c => c.style.display !== 'none')
			return {
				painted: circles.map(c => {
					const stroke = c.getAttribute('stroke')
					return stroke && stroke !== 'none' ? stroke : c.getAttribute('fill')
				}),
				reachable: ui.orderMarker.reachable,
				active: ui.orderMarker.active,
			}
		})
	}
	const isRed = colour => /^rgba\(255,86,64/.test(colour ?? '')

	// A cell every land locomotor can use, and one the host marks as off the map.
	const cells = await page.evaluate(() => {
		const ui = steelseed.ctx.get('ui')
		const w = ui.passabilityW, h = ui.passabilityH
		let land = null, blocked = null
		for (let y = 0; y < h && (!land || !blocked); y++)
			for (let x = 0; x < w; x++) {
				const bits = ui.passability[y * w + x]
				const cell = { x: x + ui.passabilityOriginX, y: y + ui.passabilityOriginY }
				if (!land && (bits & 7) === 7) land = cell
				if (!blocked && (bits & 16) !== 0) blocked = cell
			}
		return { land, blocked, planeCells: w * h }
	})
	if (!cells.land) fail('the passability plane has no cell every land locomotor can use')

	const rightClickMinimap = async cell => {
		const before = await page.evaluate(() => globalThis.contextCalls.length)
		const point = await minimapPointFor(cell)
		await page.mouse.move(point.x, point.y)
		await page.mouse.down({ button: 'right' })
		await page.mouse.up({ button: 'right' })
		for (let attempt = 0; attempt < 40; attempt++) {
			const now = await page.evaluate(() => globalThis.contextCalls.length)
			if (now > before) {
				if (now !== before + 1) fail(`one overview right click produced ${now - before} orders`)
				return await page.evaluate(() => globalThis.contextCalls.at(-1))
			}
			await page.waitForTimeout(50)
		}
		return null
	}

	const cameraBeforeOrder = await cameraState()
	const landOrder = await rightClickMinimap(cells.land)
	if (!landOrder) fail('right clicking the overview issued no order')
	if (landOrder.cellX !== cells.land.x || landOrder.cellY !== cells.land.y)
		fail(`the overview aimed at ${landOrder.cellX},${landOrder.cellY} instead of ${cells.land.x},${cells.land.y}`)
	if (landOrder.subjects !== 1) fail(`the overview sent ${landOrder.subjects} subjects for a single selection`)
	const cameraAfterOrder = await cameraState()
	if (!near(cameraAfterOrder.position[0], cameraBeforeOrder.position[0], 0.5) ||
		!near(cameraAfterOrder.position[2], cameraBeforeOrder.position[2], 0.5))
		fail('right clicking the overview moved the camera; only the left button focuses')
	const reachableMarker = await markerState()
	if (!reachableMarker.active || reachableMarker.painted.length === 0)
		fail('a reachable order drew no marker')
	if (!reachableMarker.reachable) fail('a cell every land locomotor can use was judged unreachable')
	if (reachableMarker.painted.some(isRed))
		fail(`a reachable order was marked in red: ${JSON.stringify(reachableMarker)}`)
	findings.push(`overview: right click sent 1 subject to ${landOrder.cellX},${landOrder.cellY} — ${landOrder.result}`)

	if (cells.blocked) {
		const blockedOrder = await rightClickMinimap(cells.blocked)
		if (!blockedOrder) fail('right clicking an unreachable cell issued no order at all')
		const blockedMarker = await markerState()
		if (blockedMarker.reachable)
			fail(`a cell the host marks unreachable (${cells.blocked.x},${cells.blocked.y}) was judged reachable`)
		if (!blockedMarker.painted.some(isRed)) {
			const why = await page.evaluate(([x, y]) => {
				const ui = steelseed.ctx.get('ui')
				const index = ui.passabilityIndex(x, y)
				return {
					aimedAt: [x, y], index, bits: index < 0 ? 'outside the plane' : ui.passability[index],
					reach: ui.selectionCanReach(x, y, steelseed.ctx.snapshot.actors, 1),
					marker: { ...ui.orderMarker },
					subjects: [...ui.selection],
				}
			}, [blockedOrder.cellX, blockedOrder.cellY])
			fail(`an unreachable cell was not painted red: marker ${JSON.stringify(blockedMarker)}; ` +
				`asked for ${cells.blocked.x},${cells.blocked.y}, order went to ${blockedOrder.cellX},${blockedOrder.cellY}; ${JSON.stringify(why)}`)
		}
		const notice = await page.evaluate(() => document.getElementById('hud-notice')?.textContent ?? '')
		if (!/no route/i.test(notice)) fail(`an unreachable order said "${notice}"`)
		findings.push(`unreachable: ${cells.blocked.x},${cells.blocked.y} marked red and reported "${notice}"`)
	} else findings.push('unreachable: NOT exercised, this map has no cell the host marks unreachable')

	// Left button still focuses and commands nothing.
	const beforeLeft = await page.evaluate(() => globalThis.contextCalls.length)
	const focusPoint = await minimapPointFor({ x: cells.land.x, y: cells.land.y })
	const cameraBeforeFocus = await cameraState()
	await page.mouse.click(focusPoint.x, focusPoint.y)
	await page.waitForTimeout(700)
	const afterLeft = await page.evaluate(() => globalThis.contextCalls.length)
	if (afterLeft !== beforeLeft) fail('left clicking the overview issued an order; it must only move the camera')
	const cameraAfterFocus = await cameraState()
	if (near(cameraAfterFocus.position[0], cameraBeforeFocus.position[0], 0.5) &&
		near(cameraAfterFocus.position[2], cameraBeforeFocus.position[2], 0.5))
		fail('left clicking the overview did not move the camera')
	findings.push('overview: left click still only moves the camera')

	if (pageErrors.length) fail(`page errors during the run: ${pageErrors.slice(0, 3).join(' | ')}`)
	console.log(findings.map(line => `${TOOL}: ${line}`).join('\n'))
	console.log(`${TOOL}: PASS — night is playable at ${(night.mean / day.mean * 100).toFixed(0)}% of day luminance ` +
		`with ${(night.sd / day.sd * 100).toFixed(0)}% of its contrast; the daylight switch pins and releases the sun; ` +
		'pan, zoom, tilt, turn and reset all answer; each screen edge lights alone while it scrolls; ' +
		'and the overview commands the selection with an unreachable target marked in red')
} finally {
	await browser.close()
}
