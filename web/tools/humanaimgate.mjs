#!/usr/bin/env node
// Does a rifleman in a real match actually raise his weapon, and does it read on screen?
//
// The arms had never moved. Measured on the shipped walk pack before this work: every arm
// bone -- both clavicles, both upper arms, both forearms, both hands -- carried exactly
// 0.00 degrees of rotation and zero translation on all 33 frames, while the legs swung 46
// to 81 degrees. So the aim and recoil overlays are not an improvement to existing arm
// motion; they are the only arm motion this game has, and if they do not reach the drawn
// palette there is nothing underneath them to hide the failure.
//
// A green loader gate would not have caught that, and this project has a file of gates that
// reported green on what they could not see. So this one starts a real composed match, makes
// a real rifleman shoot through OpenRA's own order path, and then asks three questions of
// the bytes that were actually uploaded to the GPU:
//
//   1. Before he fires, is the drawn palette EXACTLY the walk alone? (The overlay must not
//      leak into an idle actor.)
//   2. After he fires, is the drawn palette EXACTLY the walk plus the authored aim overlay?
//      Equality against the shipped clip, not a threshold -- this fails if the overlay is
//      unwired, wired to the wrong bones, clocked wrongly, or blended at the wrong weight.
//   3. Do the leg bones come through the two captures untouched?
//
// Every tolerance here is measured, not chosen: the noise floor is two consecutive captures
// of the same standing actor, and the separation is reported as a multiple of that floor.
// Finally it screenshots both states and measures how many pixels actually changed, because
// at gameplay zoom the figure is a few dozen pixels tall and a cue nobody can see is not a
// cue.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { WEB_ROOT, launchGpuBrowser, loadChromium } from './harness.mjs'
import { decodePng } from './png.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'

const TOOL = 'humanaimgate'
const out = join(WEB_ROOT, '.artifacts/visual-quality/human-aim')
mkdirSync(out, { recursive: true })
const motion = JSON.parse(readFileSync(join(WEB_ROOT, '.forge/human-motion/manifest.json')))
const aimEntry = motion.clips.find(c => c.id === 'infantry-aim-v1')
const fireEntry = motion.clips.find(c => c.id === 'infantry-fire-v1')
assert.ok(aimEntry && fireEntry, 'Both authored clips must ship before this gate means anything')
const STATURE = .363

const bundle = await build({
	stdin: {
		contents: `export {sampleHumanMotion,overlayHumanMotionClip} from './src/units/human-motion.ts';
			export {computeWorldTransforms,computeSkinMatrices,boneWorldPoint} from './src/geo/rig.ts';`,
		resolveDir: WEB_ROOT, loader: 'ts',
	},
	bundle: true, platform: 'browser', format: 'iife', globalName: 'aimProbe', write: false, logLevel: 'silent',
	define: { 'import.meta.glob': '__emptyGlob' }, banner: { js: 'const __emptyGlob=()=>({});' },
})

let preview, browser, context
try {
	preview = await startPrivateComposed(8479)
	;({ browser } = await launchGpuBrowser(await loadChromium(TOOL), TOOL))
	context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
	const page = await context.newPage(), errors = [], console_ = []
	page.on('pageerror', e => errors.push(e.message))
	page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console_.push(`${m.type()}: ${m.text()}`.slice(0, 300)) })
	await page.goto(`${preview.baseUrl}?mode=game&platform=null&quality=medium&weather=clear&daylight=day`)
	try {
		// Longer than the neighbouring gates because this one opens a single page: they load a
		// throwaway page first, which absorbs the cold WebAssembly compile of the composed
		// engine before the page whose clock actually matters.
		await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined, { timeout: 420000, polling: 200 })
	} catch (error) {
		console.error(`${TOOL}: session never became available. pageerrors=${JSON.stringify(errors.slice(0, 6))} console=${JSON.stringify(console_.slice(0, 12))}`)
		console.error(`${TOOL}: steelseed=${await page.evaluate(() => typeof globalThis.steelseed)} session=${await page.evaluate(() => { try { return JSON.stringify({ available: globalThis.steelseed?.ctx?.session?.available, status: globalThis.steelseed?.ctx?.session?.status }) } catch (e) { return String(e) } })}`)
		throw error
	}
	const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog())
	const map = catalog.maps.find(m => m.title === 'Marigold Town')
	assert.ok(map, 'Real Marigold Town catalog required')
	const config = configFor(catalog, map, { withBot: false })
	const faction = ['england', 'germany', 'france', 'allies'].find(id => map.factions.some(f => f.id === id))
	assert.ok(faction)
	config.local.faction = faction
	config.slots.find(s => s.slot === config.local.slot).faction = faction
	Object.assign(config.options, { startingunits: 'heavy', explored: 'True', fog: 'False', crates: 'False' })
	await page.evaluate(c => steelseed.ctx.session.startSkirmish(c), config)
	await page.waitForFunction(() => steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui').hidden,
		undefined, { timeout: 180000, polling: 100 })
	await page.addScriptTag({ content: bundle.outputFiles[0].text })

	// Install the witness. It recomputes, from the shipped clips, exactly what units should
	// have written, and records it beside what units DID write, every frame.
	const start = await page.evaluate(() => {
		const ctx = steelseed.ctx, u = ctx.get('units'), r = ctx.get('render'), anim = ctx.get('anim')
		const a = ctx.snapshot.actors, human = u.humanMotion
		if (!human) throw Error('Anatomical infantry is not the drawn figure')
		if (!human.aim || !human.fire) throw Error('Timed clips never reached units')
		let actor = null, neighbour = null
		for (let i = 0; i < a.count; i++)
			if (a.owner[i] === ctx.snapshot.world.renderPlayer && ctx.actorTypeName(a.typeId[i]) === 'e1') {
				actor = { id: a.id[i], x: a.posX[i] / 1024, z: a.posY[i] / 1024 }
				break
			}
		if (!actor) throw Error('Real starting rifleman required')
		// A target the rifleman can hit without walking anywhere: the nearest OTHER actor of
		// its own player. Ctrl on a friendly resolves to OpenRA's ForceAttack targeter, so
		// this exercises the real order path rather than a synthetic event.
		let best = Infinity
		for (let i = 0; i < a.count; i++) {
			if (a.id[i] === actor.id || a.owner[i] !== ctx.snapshot.world.renderPlayer) continue
			const dx = a.posX[i] / 1024 - actor.x, dz = a.posY[i] / 1024 - actor.z
			const d = Math.hypot(dx, dz)
			if (d < best && d > .5) { best = d; neighbour = { id: a.id[i], x: a.posX[i] / 1024, z: a.posY[i] / 1024, cells: d } }
		}
		if (!neighbour) throw Error('No neighbouring actor to force-attack')
		const cam = ctx.get('camera')
		const gameplayHeight = cam.height
		cam.focusWorld(actor.x, actor.z)
		cam.height = cam.heightGoal = 5
		cam.yaw = cam.yawGoal = .6
		const bucket = u.slotBuckets.get('e1')
		const sk = human.rig.skeleton, pose = sk.createPose()
		const world = sk.createMatrixBuffer(), skin = sk.createMatrixBuffer()
		const encode = r.encodeFrame.bind(r)
		const handR = sk.names.indexOf('hand_r')
		globalThis.aimWitness = { id: actor.id, latest: null, series: [], serial: 0 }
		r.encodeFrame = function () {
			for (let it = 0; it < r.itemCount; it++) {
				const item = r.items[it]
				if (item !== bucket.item) continue
				for (let n = 0; n < item.instanceCount; n++) {
					if (item.motionIds[n] !== actor.id) continue
					const alpha = ctx.time.alpha
					const distance = anim.interpolatedDistanceOf(actor.id, alpha) / human.scale
					const aimWeight = anim.interpolatedAimOf(actor.id, alpha)
					const since = anim.secondsSinceFire(actor.id, alpha)
					// Walk-only expectation first, so the two can be compared separately.
					aimProbe.sampleHumanMotion(human.clip, pose, distance)
					aimProbe.computeWorldTransforms(pose, world)
					aimProbe.computeSkinMatrices(sk, world, skin)
					const base = item.paletteBases[n] * 16
					let walkOnly = 0
					for (let k = 0; k < skin.length; k++) walkOnly = Math.max(walkOnly, Math.abs(r.boneData[base + k] - skin[k]))
					// Then the full expectation units should have drawn.
					// Guarded, because the screen-space A/B below deliberately nulls these to
					// isolate the overlay's own pixels; the witness must mirror units exactly.
					if (human.aim && aimWeight > 0)
						aimProbe.overlayHumanMotionClip(human.aim, pose, aimWeight * human.aim.durationS, aimWeight)
					if (human.fire && since >= 0 && since < human.fire.durationS)
						aimProbe.overlayHumanMotionClip(human.fire, pose, since, 1)
					aimProbe.computeWorldTransforms(pose, world)
					aimProbe.computeSkinMatrices(sk, world, skin)
					let withOverlay = 0
					for (let k = 0; k < skin.length; k++) withOverlay = Math.max(withOverlay, Math.abs(r.boneData[base + k] - skin[k]))
					const hand = [world[handR * 16 + 12], world[handR * 16 + 13], world[handR * 16 + 14]]
					globalThis.aimWitness.latest = {
						serial: ++globalThis.aimWitness.serial, tick: ctx.time.tick, alpha, distance,
						aimWeight, since, walkOnlyError: walkOnly, overlayError: withOverlay,
						hand, palette: Array.from(r.boneData.subarray(base, base + skin.length)),
						included: !!r.itemIncluded[it],
					}
					if (globalThis.aimWitness.series.length < 4000)
						globalThis.aimWitness.series.push({ ...globalThis.aimWitness.latest, palette: undefined })
				}
			}
			return encode()
		}
		return { actor, neighbour, bones: sk.boneCount, handR, gameplayHeight, names: Array.from(sk.names) }
	})
	assert.ok(start.handR >= 0, 'The rig must name the weapon hand')

	const capture = async () => {
		await page.evaluate(() => steelseed.renderOneFrame(performance.now()))
		return page.evaluate(() => globalThis.aimWitness.latest)
	}
	await page.waitForFunction(() => globalThis.aimWitness.latest?.included, undefined, { timeout: 60000, polling: 50 })

	// --- Idle. Never fired, standing still. -------------------------------------------
	const idleA = await capture()
	const idleB = await capture()
	assert.equal(idleA.aimWeight, 0, 'A rifleman that has never fired must not be aiming')
	assert.ok(idleA.since < 0, 'A rifleman that has never fired must have no shot on the clock')
	// The measured noise floor: two consecutive captures of the same standing actor. Every
	// tolerance below is this number, not a number anyone picked.
	let floor = 0
	for (let k = 0; k < idleA.palette.length; k++) floor = Math.max(floor, Math.abs(idleA.palette[k] - idleB.palette[k]))
	const tolerance = Math.max(floor, 1e-6) * 8
	assert.ok(idleA.walkOnlyError <= tolerance,
		`Idle palette is not the walk alone: ${idleA.walkOnlyError} > ${tolerance}`)

	// --- Fire, through OpenRA's own order path. ----------------------------------------
	// Three ways of asking, because which one a rules set accepts is not something to guess:
	// the contextual ForceAttack a Ctrl-click produces, an explicit Attack on the actor, and
	// a forced attack on the ground under it. The first that produces a real weaponFire wins,
	// and which one it was is reported.
	const attempts = [
		['contextual-forceattack', { orderString: 'Contextual', contextual: true, useTarget: true, modifiers: 1 }],
		['attack-actor', { orderString: 'Attack', contextual: false, useTarget: true, modifiers: 0 }],
		['forceattack-cell', { orderString: 'Contextual', contextual: true, useTarget: false, modifiers: 1 }],
	]
	let ordered = null
	for (const [name, shape] of attempts) {
		await page.evaluate(({ id, target, cell, shape }) => {
			steelseed.ctx.issueOrder({
				orderString: shape.orderString, contextual: shape.contextual,
				subjectIds: Uint32Array.of(id), subjectCount: 1,
				targetActorId: shape.useTarget ? target : 0, targetFrozen: false,
				targetCell: cell, modifiers: shape.modifiers,
			})
		}, { id: start.actor.id, target: start.neighbour.id, shape,
			cell: { x: Math.floor(start.neighbour.x), y: Math.floor(start.neighbour.z) } })
		try {
			await page.waitForFunction(() => globalThis.steelseed.ctx.get('anim').secondsSinceFire(globalThis.aimWitness.id, 1) >= 0,
				undefined, { timeout: 25000, polling: 50 })
			ordered = name
			break
		} catch { /* try the next shape */ }
	}
	if (ordered === null) {
		const state = await page.evaluate(id => {
			const snap = steelseed.ctx.snapshot
			for (let i = 0; i < snap.actors.count; i++)
				if (snap.actors.id[i] === id) return { flags: snap.actors.flags[i], tick: snap.tick }
			return { flags: -1, tick: snap.tick }
		}, start.actor.id)
		assert.fail(`No weaponFire from actor ${start.actor.id} after ${attempts.length} order shapes; ` +
			`flags=${state.flags} tick=${state.tick} target=${start.neighbour.id} at ${start.neighbour.cells.toFixed(2)} cells`)
	}
	const firstShotTick = (await capture()).tick
	// The ramp is authored at 0.55 s; wait for it to finish rather than counting frames. Two
	// further ticks, because the weight the frame uses is interpolated between the last two
	// ticks: at the tick the ramp first reaches 1 a mid-tick frame still reads about 0.96.
	await page.waitForFunction(() => globalThis.steelseed.ctx.get('anim').aimOf(globalThis.aimWitness.id) >= 1,
		undefined, { timeout: 120000, polling: 50 })
	const rampTick = (await capture()).tick
	await page.waitForFunction(t => globalThis.steelseed.ctx.snapshot.tick > t + 2, rampTick,
		{ timeout: 120000, polling: 50 })
	const aimed = await capture()
	assert.equal(aimed.aimWeight, 1, 'The aim ramp must reach and hold full')
	assert.ok(aimed.overlayError <= tolerance,
		`Aimed palette is not the walk plus the authored aim clip: ${aimed.overlayError} > ${tolerance}`)

	// --- What actually changed, and what did not. --------------------------------------
	let separation = 0
	for (let k = 0; k < aimed.palette.length; k++)
		separation = Math.max(separation, Math.abs(aimed.palette[k] - idleA.palette[k]))
	assert.ok(separation > tolerance * 20,
		`The drawn rifleman barely moved: separation ${separation} against a measured floor of ${floor}`)
	// Legs and pelvis come through untouched, at runtime, not merely in the pack.
	const owned = new Set(motion.upperBodyBones)
	let legDrift = 0, legBones = 0
	for (let bone = 0; bone < start.bones; bone++) {
		if (owned.has(bone)) continue
		legBones++
		for (let k = bone * 16; k < bone * 16 + 16; k++)
			legDrift = Math.max(legDrift, Math.abs(aimed.palette[k] - idleA.palette[k]))
	}
	assert.ok(legDrift <= tolerance,
		`The overlay moved a bone it does not own: ${legDrift} across ${legBones} unmasked bones`)
	const handTravel = Math.hypot(aimed.hand[0] - idleA.hand[0], aimed.hand[1] - idleA.hand[1], aimed.hand[2] - idleA.hand[2])

	// --- Recoil: watch the weapon hand across the clip's own window. --------------------

	// Bone transforms are model-space, so the actor turning to face its target cannot move
	// this number; only the pose can. The floor is the same idle pair measured above.
	const handFloor = Math.max(1e-6, Math.hypot(idleA.hand[0] - idleB.hand[0],
		idleA.hand[1] - idleB.hand[1], idleA.hand[2] - idleB.hand[2]))
	// This page only draws when asked, so a 0.30 s pulse is invisible to on-demand captures.
	// Drive a dense burst inside the page instead, while the rifleman keeps shooting, so
	// frames actually land inside the window.
	await page.evaluate(async ms => {
		const end = performance.now() + ms
		while (performance.now() < end) {
			globalThis.steelseed.renderOneFrame(performance.now())
			await new Promise(resolve => setTimeout(resolve, 8))
		}
	}, 6000)
	const series = await page.evaluate(() => globalThis.aimWitness.series)
	const settled = series.filter(f => f.aimWeight >= 1 && (f.since < 0 || f.since >= fireEntry.durationS))
	const inClip = series.filter(f => f.aimWeight >= 1 && f.since >= 0 && f.since < fireEntry.durationS)
	assert.ok(inClip.length > 0, 'No frame was ever drawn inside a recoil pulse')
	assert.ok(settled.length > 0, 'The rifleman never settled between shots, so there is no baseline')
	const baseline = settled.reduce((sum, f) => sum + f.hand[1], 0) / settled.length
	let recoilPeak = 0, recoilPeakAt = 0
	for (const frame of inClip)
		if (frame.hand[1] - baseline > recoilPeak) { recoilPeak = frame.hand[1] - baseline; recoilPeakAt = frame.since }
	assert.ok(recoilPeak > handFloor * 4,
		`The weapon hand does not lift on a shot: ${recoilPeak} m against a measured floor of ${handFloor} m`)

	// --- Does it read? Screenshot both states and count the pixels that changed. --------
	const shot = async name => {
		const png = await page.screenshot({ type: 'png' })
		writeFileSync(join(out, name), png)
		return decodePng(png)
	}
	const channelDelta = (a, b, i) => Math.max(Math.abs(a.data[i] - b.data[i]),
		Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]))
	/**
	 * Pixels the overlay changed, with the renderer's own instability subtracted per pixel.
	 *
	 * A plain two-frame difference reported 388,813 pixels changed in a box covering the
	 * whole 1200x900 viewport, with the simulation paused and only the overlay toggled --
	 * which cannot be one soldier. Temporal accumulation moves nearly every pixel a little
	 * between any two frames. So `noise` is two frames taken with the overlay ON and nothing
	 * else changed, and a pixel only counts when the overlay difference exceeds what that
	 * same pixel did on its own. The threshold is measured per pixel, not chosen.
	 */
	const difference = (a, b, noise) => {
		let changed = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, peak = 0
		for (let y = 0; y < a.height; y++)
			for (let x = 0; x < a.width; x++) {
				const i = (y * a.width + x) * 4
				const d = channelDelta(a, b, i)
				if (d > peak) peak = d
				if (d <= channelDelta(a, noise, i) + 8) continue
				changed++
				if (x < minX) minX = x
				if (x > maxX) maxX = x
				if (y < minY) minY = y
				if (y > maxY) maxY = y
			}
		return { changed, peak, box: changed ? [minX, minY, maxX - minX + 1, maxY - minY + 1] : null }
	}
	const settle = async want => {
		await page.waitForFunction(w => globalThis.steelseed.ctx.get('anim').aimOf(globalThis.aimWitness.id) === w,
			want, { timeout: 120000, polling: 100 })
		for (let i = 0; i < 4; i++) await capture()
	}
	// Does it read? The first attempt here compared an aimed screenshot with a lowered one
	// and reported that 708,661 of 1,080,000 pixels had changed inside a box covering the
	// entire viewport. That is not the soldier: seconds pass between those two shots, the
	// grass moves, the force-attacked actor dies, and a whole-frame difference measures the
	// scene rather than the work. So this pauses the simulation and toggles ONLY the two
	// overlays between two renders taken microseconds apart. Every pixel that differs then
	// is the aim and nothing else.
	const paused = await page.evaluate(() => steelseed.ctx.session.setPaused(true))
	assert.doesNotMatch(paused, /error/i, 'The simulation must pause before an isolated A/B')
	for (let i = 0; i < 3; i++) await capture()
	const frame = async name => {
		await page.evaluate(() => steelseed.renderOneFrame(performance.now()))
		const png = await page.screenshot({ type: 'png' })
		if (name) writeFileSync(join(out, name), png)
		return decodePng(png)
	}
	const overlayDifference = async label => {
		const on = await frame(`${label}-aimed.png`)
		const again = await frame(null)
		await page.evaluate(() => {
			const human = steelseed.ctx.get('units').humanMotion
			globalThis.__heldClips = { aim: human.aim, fire: human.fire }
			human.aim = null
			human.fire = null
		})
		const off = await frame(`${label}-noOverlay.png`)
		await page.evaluate(() => {
			const human = steelseed.ctx.get('units').humanMotion
			human.aim = globalThis.__heldClips.aim
			human.fire = globalThis.__heldClips.fire
		})
		await frame(null)
		return difference(on, off, again)
	}
	const close = await overlayDifference('close')
	await page.evaluate(v => {
		const cam = steelseed.ctx.get('camera')
		cam.height = cam.heightGoal = v
	}, start.gameplayHeight)
	for (let i = 0; i < 3; i++) await capture()
	const far = await overlayDifference('gameplay')
	await page.evaluate(() => steelseed.ctx.session.setPaused(false))
	// REPORTED, NOT ASSERTED, and the reason matters. By the time the rifleman is aiming it
	// has been shooting a neighbour at 1.4 cells for several seconds, and the combat effect
	// that produces covers the soldier completely -- open close-aimed.png and he is not
	// visible at all under it. Both counts here are scattered temporal residue rather than a
	// silhouette (the boxes span most of the viewport, and the far count is LARGER than the
	// near one, which no real cue does), so asserting on them would be asserting on something
	// this gate cannot see. The readable size is measured separately and honestly: in a clean
	// pre-combat frame at camera height 5 the drawn rifleman's player-coloured silhouette
	// spans 26 x 26 px, which at the 23.6 m height the game opens on is about 5.5 px tall.
	// A 20%-of-stature muzzle lift is then roughly one pixel, and the recoil a third of one.
	const changed = close.changed, box = close.box ?? [0, 0, 0, 0]
	const minX = box[0], minY = box[1], maxX = minX + box[2] - 1, maxY = minY + box[3] - 1
	assert.deepEqual(errors, [])
	const summary = {
		map: map.title, actor: start.actor.id, target: start.neighbour.id,
		targetCells: Number(start.neighbour.cells.toFixed(2)),
		// The floor came out at exactly zero: with nothing moving, two consecutive captures of
		// the same actor are bit-identical, so the guard below is a floor of last resort and
		// NOT a measurement. What carries the weight is that both equality errors are 0.
		measuredNoiseFloor: floor, toleranceGuard: tolerance,
		idleWalkOnlyError: idleA.walkOnlyError, aimedOverlayError: aimed.overlayError,
		paletteSeparation: separation,
		unmaskedBoneDrift: legDrift, unmaskedBones: legBones,
		weaponHandTravelM: handTravel, weaponHandTravelStature: handTravel / STATURE,
		firstShotTick, orderShape: ordered, aimSeconds: aimEntry.durationS, fireSeconds: fireEntry.durationS,
		closeCameraHeight: 5, gameplayCameraHeight: start.gameplayHeight,
		overlayPixelsChangedClose: changed,
		overlayChangeBoxClose: [minX, minY, maxX - minX + 1, maxY - minY + 1],
		overlayPixelsChangedGameplay: far.changed, overlayChangeBoxGameplay: far.box,
		overlayPeakChannelClose: close.peak, overlayPeakChannelGameplay: far.peak,
		screenClaim: 'unmeasured: the combat effect the gate itself creates hides the soldier',
		measuredSilhouettePxAtHeight5: 26, estimatedSilhouettePxAtGameplayHeight: 5.5,
		frames: series.length, recoilFramesSampled: inClip.length, settledFramesSampled: settled.length,
		measuredHandNoiseFloorM: handFloor, recoilHandLiftM: recoilPeak,
		recoilHandLiftStature: recoilPeak / STATURE, recoilPeakAtS: recoilPeakAt,
		authoredMuzzleRiseStature: .0495,
		limitation: 'Equality of the drawn palette against the shipped clips for ONE rifleman in ' +
			'one real match, plus a paused A/B that toggles only the overlays. The palette ' +
			'tolerance is a guard, not a measurement: the measured frame-to-frame floor is zero ' +
			'and both equality errors are exactly zero. Not proven here: recoil timing under ' +
			'sustained fire, cost with a crowd on screen, whether the aim READS on screen (the ' +
			'pixel counts here are residue, not a silhouette), or that the authored pose is ' +
			'anatomically right rather than merely reaching the screen.',
	}
	writeFileSync(join(out, 'report.json'), JSON.stringify({ summary, series }, null, 2))
	console.log(`${TOOL} PASS`, JSON.stringify(summary))
} finally {
	await context?.close()
	await browser?.close()
	await preview?.close()
}
