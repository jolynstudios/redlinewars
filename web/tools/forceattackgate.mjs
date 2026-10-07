#!/usr/bin/env node
// STEELSEED — tools/forceattackgate
// Ctrl + right click is force attack, and it reaches OpenRA as OpenRA's own modifier.
//
// The presentation layer never decides what a click means: it sends selection, target and
// TargetModifiers, and the host runs the same prioritized IOrderTargeters as
// UnitOrderGenerator (Program.Bridge.cs ContextOrderFor). So the only things worth proving
// here are the ones that can actually break on this side of the seam:
//
//   1. a plain right click on open ground is still Move,
//   2. Ctrl + right click on the same ground resolves to OpenRA's ForceAttack targeter,
//   3. a plain right click on a friendly unit is not an attack,
//   4. Ctrl + right click on that same friendly unit is,
//   5. a mixed group is filtered by OpenRA, not by the browser: the bridge issues fewer
//      orders than there are subjects and names only the targeters that really applied,
//   7. and it decides in the other direction too: a Ctrl left latched down in key state by a
//      lost keyup must not force-attack a click the player made without it.
//
//   6. the modifier travels with the press. `input.ctrl` is keyboard state on `window` and
//      window blur clears it, so a player who alt-tabs back into the game still holding
//      Ctrl would force-attack nothing and drive into the target instead. Measured on the
//      build before this gate existed: that sequence sent modifier bits 0. The UI now takes
//      ctrlKey from the pointerdown, so a cleared key state must not change the order.
//
// The instrument is the bridge's own reply string, which names the resolved targeters
// ("ok: issued 1/1 OpenRA contextual orders (ForceAttack)"), plus the modifier bits the UI
// actually sent. Both halves have to agree or the case fails.
//
//   node tools/forceattackgate.mjs [--url http://127.0.0.1:8321/steelseed/index.html]

import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const TOOL = 'forceattackgate'
const arg = (name, fallback) => {
	const found = process.argv.find(value => value.startsWith(`--${name}=`))
	return found ? found.slice(name.length + 3) : fallback
}
const base = arg('url', 'http://127.0.0.1:8321/steelseed/index.html')
const MODIFIER_FORCE_ATTACK = 1

const fail = message => { throw new Error(`${TOOL}: ${message}`) }
const findings = []

const { browser } = await launchGpuBrowser(await loadChromium(TOOL), TOOL)
const page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
try {
	await page.goto(`${base}?mode=game&platform=null&quality=medium&daylight=day`,
		{ waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined,
		{ timeout: 180000, polling: 100 })
	const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog())
	const map = catalog.maps.find(entry => entry.title === 'Marigold Town') ?? catalog.maps[0]
	const config = configFor(catalog, map, { withBot: true })
	config.options.startingunits = 'heavy'
	config.options.explored = 'True'
	config.options.fog = 'False'
	await page.evaluate(value => steelseed.ctx.session.startSkirmish(value), config)
	await page.waitForFunction(
		() => steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui').hidden,
		undefined, { timeout: 180000, polling: 100 })
	await page.waitForTimeout(2500)

	// Record every contextual order at the seam the app actually uses: the host bridge's
	// issueContextOrder (the UI awaits its resolved targeter result). Nothing else in this
	// gate is allowed to be the witness.
	await page.evaluate(() => {
		globalThis.contextCalls = []
		const bridge = steelseed.bridge
		const inner = bridge.issueContextOrder.bind(bridge)
		bridge.issueContextOrder = order => {
			// Key state as the order is issued, so the negative case can prove the latch was
			// still down and did not simply expire before the frame that mattered.
			globalThis.latchedCtrlWhenOrdered = steelseed.ctx.input.ctrl
			const call = { args: [order], result: null }
			globalThis.contextCalls.push(call)
			return inner(order).then(resolved => { call.result = resolved; return resolved })
		}
	})

	const world = await page.evaluate(() => {
		const { ctx } = steelseed
		const actors = ctx.snapshot.actors
		const me = ctx.snapshot.world.renderPlayer
		const mine = []
		for (let i = 0; i < actors.count; i++)
			if (actors.owner[i] === me)
				mine.push({
					id: actors.id[i], name: ctx.actorTypeName(actors.typeId[i]),
					x: actors.posX[i] / 1024, z: actors.posY[i] / 1024,
				})
		return { me, mine }
	})
	const shooter = world.mine.find(a => ['2tnk', '3tnk', '1tnk', 'jeep'].includes(a.name))
		?? fail(`no armed vehicle in the starting force: ${world.mine.map(a => a.name).join(',')}`)
	const friendly = world.mine.find(a => a.id !== shooter.id && ['harv', 'mcv', '2tnk', '3tnk'].includes(a.name))
		?? fail('no second own actor to force-fire at')
	// Anything of mine that carries no weapon: the group case needs one actor OpenRA must
	// decide about differently from the tank.
	const unarmed = world.mine.find(a => a.id !== shooter.id && ['harv', 'mcv'].includes(a.name))
	const passenger = world.mine.find(a => ['e1', 'e2', 'e3', 'e6', 'medi'].includes(a.name))
	const transport = world.mine.find(a => ['apc', 'truk', 'lst'].includes(a.name))
	findings.push(`starting force: ${[...new Set(world.mine.map(a => a.name))].sort().join(' ')}`)

	/** Screen position of an actor's drawn centre, straight from the render camera. */
	const project = id => page.evaluate(actorId => {
		const ctx = steelseed.ctx
		const units = ctx.get('units')
		const matrix = new Float32Array(16)
		const visual = { mesh: null, surfaceSet: '', playerColor: 0, boneCount: 0, paletteBase: 0 }
		if (!units.captureActorVisual(actorId, matrix, 0, visual) || !visual.mesh) return null
		const mesh = visual.mesh
		const centre = [0, 1, 2].map(k => (mesh.aabbMin[k] + mesh.aabbMax[k]) * 0.5)
		const w = [
			matrix[0] * centre[0] + matrix[4] * centre[1] + matrix[8] * centre[2] + matrix[12],
			matrix[1] * centre[0] + matrix[5] * centre[1] + matrix[9] * centre[2] + matrix[13],
			matrix[2] * centre[0] + matrix[6] * centre[1] + matrix[10] * centre[2] + matrix[14],
		]
		const vp = ctx.get('render').camera.viewProj
		const cw = vp[3] * w[0] + vp[7] * w[1] + vp[11] * w[2] + vp[15]
		if (cw <= 0) return null
		const cx = vp[0] * w[0] + vp[4] * w[1] + vp[8] * w[2] + vp[12]
		const cy = vp[1] * w[0] + vp[5] * w[1] + vp[9] * w[2] + vp[13]
		return {
			x: (cx / cw * 0.5 + 0.5) * ctx.canvas.clientWidth,
			y: (0.5 - cy / cw * 0.5) * ctx.canvas.clientHeight,
		}
	}, id)

	/**
	 * A screen point that lands on open ground: it must resolve to a map cell and keep every
	 * actor further away than the UI's own pick radius, or the click would target a unit and
	 * the case would prove nothing about ground orders.
	 */
	const openGroundPoint = () => page.evaluate(() => {
		const ctx = steelseed.ctx
		const camera = ctx.get('camera')
		const units = ctx.get('units')
		const actors = ctx.snapshot.actors
		const vp = ctx.get('render').camera.viewProj
		const width = ctx.canvas.clientWidth
		const height = ctx.canvas.clientHeight
		const screen = []
		for (let i = 0; i < actors.count; i++) {
			const matrix = new Float32Array(16)
			const visual = { mesh: null, surfaceSet: '', playerColor: 0, boneCount: 0, paletteBase: 0 }
			if (!units.captureActorVisual(actors.id[i], matrix, 0, visual) || !visual.mesh) continue
			const mesh = visual.mesh
			const c = [0, 1, 2].map(k => (mesh.aabbMin[k] + mesh.aabbMax[k]) * 0.5)
			const w = [
				matrix[0] * c[0] + matrix[4] * c[1] + matrix[8] * c[2] + matrix[12],
				matrix[1] * c[0] + matrix[5] * c[1] + matrix[9] * c[2] + matrix[13],
				matrix[2] * c[0] + matrix[6] * c[1] + matrix[10] * c[2] + matrix[14],
			]
			const cw = vp[3] * w[0] + vp[7] * w[1] + vp[11] * w[2] + vp[15]
			if (cw <= 0) continue
			screen.push([
				(vp[0] * w[0] + vp[4] * w[1] + vp[8] * w[2] + vp[12]) / cw * 0.5 * width + width * 0.5,
				height * 0.5 - (vp[1] * w[0] + vp[5] * w[1] + vp[9] * w[2] + vp[13]) / cw * 0.5 * height,
			])
		}
		let best = null
		for (let y = height * 0.25; y <= height * 0.75; y += 24)
			for (let x = width * 0.2; x <= width * 0.8; x += 24) {
				const cell = camera.pickGroundCell(x, y, ctx)
				if (!cell) continue
				let nearest = Infinity
				for (const [sx, sy] of screen) nearest = Math.min(nearest, Math.hypot(sx - x, sy - y))
				if (best === null || nearest > best.clearancePx)
					best = { x, y, cell, clearancePx: nearest }
			}
		return best
	})

	const clicksBefore = () => page.evaluate(() => globalThis.contextCalls.length)
	const lastCall = () => page.evaluate(() => globalThis.contextCalls.at(-1) ?? null)

	/**
	 * One right click through the real input path. `ctrl: 'key'` holds Control the way a
	 * player does; `ctrl: 'press-only'` holds it and then clears the page's key state, which
	 * is what a window blur does, leaving only the pointer event carrying the modifier.
	 */
	const rightClick = async (x, y, ctrl = 'none') => {
		const before = await clicksBefore()
		// 'latched' fakes the opposite disagreement: a keyup lost to a blur or a focus change
		// leaves ControlLeft stuck down in the page's key state while the player is plainly
		// not holding it. The press must win, or an ordinary click opens fire on a friendly.
		if (ctrl === 'latched')
			await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft' })))
		else if (ctrl !== 'none') await page.keyboard.down('Control')
		if (ctrl === 'press-only') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
		await page.mouse.move(x, y)
		await page.mouse.down({ button: 'right' })
		await page.mouse.up({ button: 'right' })
		// The latch must stay down until the order has actually reached the bridge. Clearing
		// it first would let the old key-state path answer correctly for the wrong reason,
		// and the negative case would pass without testing anything.
		try {
			if (ctrl !== 'latched' && ctrl !== 'none') await page.keyboard.up('Control')
			for (let attempt = 0; attempt < 40; attempt++) {
				if (await clicksBefore() > before) {
					await page.waitForFunction(() => { const c = globalThis.contextCalls.at(-1); return c !== null && typeof c.result === 'string' },
						undefined, { timeout: 10000, polling: 25 })
					return await lastCall()
				}
				await page.waitForTimeout(50)
			}
			return null
		} finally {
			if (ctrl === 'latched')
				await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ControlLeft' })))
		}
	}

	const record = (name, call, { expect, forbid, modifierBit }) => {
		if (!call) fail(`${name}: no contextual order reached the bridge`)
		// issueContextOrder(order): order.modifiers carries the force-attack bit; the
		// resolved string is OpenRA's targeter verdict, e.g. "Move (Move)".
		const modifiers = Number(call.args[0]?.modifiers ?? 0)
		const forced = (modifiers & MODIFIER_FORCE_ATTACK) !== 0
		const resolved = /\(([^)]*)\)\s*$/.exec(call.result)?.[1] ?? ''
		const names = resolved ? resolved.split(',') : []
		if (modifierBit !== undefined && forced !== modifierBit)
			fail(`${name}: the browser sent modifiers ${modifiers}, force-attack bit ${forced ? 'set' : 'clear'}, expected the opposite`)
		const wanted = expect === undefined ? [] : [expect].flat()
		const banned = forbid === undefined ? [] : [forbid].flat()
		if (wanted.length && !wanted.some(order => names.includes(order)))
			fail(`${name}: OpenRA resolved [${names.join(',') || 'nothing'}], expected ${wanted.join(' or ')} — ${call.result}`)
		for (const order of banned)
			if (names.includes(order))
				fail(`${name}: OpenRA resolved ${order}, which this click must never produce — ${call.result}`)
		findings.push(`${name}: modifiers=${modifiers} → ${call.result}`)
		return { names, modifiers, result: call.result }
	}

	// --- select the shooter, on its own, with a real click ----------------------------------
	await page.evaluate(a => steelseed.ctx.get('camera').focusWorld(a.x, a.z), shooter)
	await page.waitForTimeout(700)
	const shooterAt = await project(shooter.id) ?? fail('the shooter is not on screen after focusing it')
	await page.mouse.click(shooterAt.x, shooterAt.y)
	await page.waitForTimeout(400)
	const selected = await page.evaluate(() => Array.from(steelseed.ctx.get('ui').selection))
	if (!selected.includes(shooter.id))
		fail(`clicking the ${shooter.name} at ${shooterAt.x.toFixed(0)},${shooterAt.y.toFixed(0)} selected ${JSON.stringify(selected)}`)

	// --- 1 & 2. open ground, without and with Ctrl ------------------------------------------
	const ground = await openGroundPoint() ?? fail('no open ground point on screen')
	if (ground.clearancePx < 60)
		fail(`the clearest ground point is only ${ground.clearancePx.toFixed(0)} px from an actor; a click there is not a ground order`)
	const move = record('plain right click on open ground',
		await rightClick(ground.x, ground.y), { expect: 'Move', forbid: ['Attack', 'ForceAttack'], modifierBit: false })
	const forceGround = record('Ctrl + right click on the same ground',
		await rightClick(ground.x, ground.y, 'key'), { expect: 'ForceAttack', modifierBit: true })

	// --- 3 & 4. a friendly unit, without and with Ctrl ---------------------------------------
	await page.evaluate(a => steelseed.ctx.get('camera').focusWorld(a.x, a.z), friendly)
	await page.waitForTimeout(700)
	const friendlyAt = await project(friendly.id) ?? fail('the friendly target is not on screen')
	const friendlyPlain = record(`plain right click on my own ${friendly.name}`,
		await rightClick(friendlyAt.x, friendlyAt.y), { forbid: ['Attack', 'ForceAttack'], modifierBit: false })
	const friendlyForced = record(`Ctrl + right click on my own ${friendly.name}`,
		await rightClick(friendlyAt.x, friendlyAt.y, 'key'), { expect: 'ForceAttack', modifierBit: true })

	// --- 5. a mixed group is filtered by OpenRA ----------------------------------------------
	let group = null
	if (unarmed) {
		// Build the group the way a player does: click one, Shift-click the other. The UI
		// treats Shift as additive (updateSelectionInteraction), so this is the real path.
		await page.evaluate(([a, b]) => {
			const camera = steelseed.ctx.get('camera')
			camera.focusWorld((a.x + b.x) / 2, (a.z + b.z) / 2)
			camera.heightGoal = 46
			camera.height = 46
		}, [shooter, unarmed])
		await page.waitForTimeout(900)
		const shooterPoint = await project(shooter.id)
		const unarmedPoint = await project(unarmed.id)
		if (shooterPoint && unarmedPoint) {
			await page.mouse.click(shooterPoint.x, shooterPoint.y)
			await page.waitForTimeout(250)
			await page.keyboard.down('Shift')
			await page.mouse.click(unarmedPoint.x, unarmedPoint.y)
			await page.keyboard.up('Shift')
			await page.waitForTimeout(350)
			const groupSelection = await page.evaluate(() => Array.from(steelseed.ctx.get('ui').selection))
			if (groupSelection.length !== 2 || !groupSelection.includes(shooter.id) || !groupSelection.includes(unarmed.id))
				fail(`Shift-click did not build the mixed group: selected ${JSON.stringify(groupSelection)}, ` +
					`wanted the ${shooter.name} (${shooter.id}) and the ${unarmed.name} (${unarmed.id})`)
			const groundAgain = await openGroundPoint() ?? fail('no open ground for the group case')
			const callsBeforeGroup = await page.evaluate(() => globalThis.contextCalls.length)
			const call = await rightClick(groundAgain.x, groundAgain.y, 'key')
			group = record(`Ctrl + right click with a ${shooter.name} and an unarmed ${unarmed.name} selected`,
				call, { expect: 'ForceAttack', modifierBit: true })
			// The browser must send ONE request for the whole group and let the host split it.
			// Two calls, or one order name covering two very different units, would mean the
			// presentation layer had decided who may attack — the thing it is not allowed to know.
			const groupCalls = await page.evaluate(() => globalThis.contextCalls.length)
			if (groupCalls !== callsBeforeGroup + 1)
				fail(`one Ctrl + right click on a two-unit group produced ${groupCalls - callsBeforeGroup} bridge calls; it must be exactly one`)
			// `call.args` is `[order]` — the order OBJECT. Number(order) is always NaN;
			// the subject count travels on the order itself.
			const sentSubjects = Number(call.args[0]?.subjectCount ?? 0)
			if (sentSubjects !== 2)
				fail(`the browser sent ${sentSubjects} subjects for a two-unit selection; the group must travel as one request`)
			const issued = /issued (\d+)\/(\d+)/.exec(group.result)
			if (!issued) fail(`the bridge did not report an issued count: ${group.result}`)
			const splitByHost = Number(issued[1]) < Number(issued[2]) || group.names.length > 1
			if (!splitByHost)
				fail(`the ${shooter.name} and the unarmed ${unarmed.name} both resolved to ${group.names.join(',')} ` +
					`(${issued[0]}); OpenRA is supposed to answer per actor`)
		}
		// Back to a single selection for the last case.
		const shooterAgain = await project(shooter.id)
		if (shooterAgain) {
			await page.mouse.click(shooterAgain.x, shooterAgain.y)
			await page.waitForTimeout(300)
		}
	}

	// --- 6. the modifier belongs to the press, not to stale key state -------------------------
	const groundLast = await openGroundPoint() ?? fail('no open ground for the blur case')
	const afterBlur = record('Ctrl + right click after a window blur cleared the key state',
		await rightClick(groundLast.x, groundLast.y, 'press-only'), { expect: 'ForceAttack', modifierBit: true })

	// --- 6b. an ordinary right click onto a transport still means enter, not attack -----------
	let enter = null
	if (passenger && transport) {
		await page.evaluate(([a, b]) => {
			const camera = steelseed.ctx.get('camera')
			camera.focusWorld((a.x + b.x) / 2, (a.z + b.z) / 2)
			camera.heightGoal = 40
			camera.height = 40
		}, [passenger, transport])
		await page.waitForTimeout(900)
		const passengerAt = await project(passenger.id)
		const transportAt = await project(transport.id)
		if (passengerAt && transportAt) {
			await page.mouse.click(passengerAt.x, passengerAt.y)
			await page.waitForTimeout(300)
			const riding = await page.evaluate(() => Array.from(steelseed.ctx.get('ui').selection))
			if (riding.includes(passenger.id))
				enter = record(`plain right click with a ${passenger.name} onto my ${transport.name}`,
					await rightClick(transportAt.x, transportAt.y),
					{ expect: 'EnterTransport', forbid: ['Attack', 'ForceAttack'], modifierBit: false })
		}
		// Back to the shooter for the remaining cases.
		await page.evaluate(a => steelseed.ctx.get('camera').focusWorld(a.x, a.z), shooter)
		await page.waitForTimeout(700)
		const shooterBack = await project(shooter.id)
		if (shooterBack) {
			await page.mouse.click(shooterBack.x, shooterBack.y)
			await page.waitForTimeout(300)
		}
	}

	// --- 7. a latched Ctrl key must not force attack a press that had no modifier ------------
	const groundLatched = await openGroundPoint() ?? fail('no open ground for the latched-key case')
	await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft' })))
	const latchedSeen = await page.evaluate(() => steelseed.ctx.input.ctrl)
	await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ControlLeft' })))
	if (!latchedSeen)
		fail('a synthetic ControlLeft keydown did not reach input.ctrl, so the latched-key case would prove nothing')
	const latchedCall = await rightClick(groundLatched.x, groundLatched.y, 'latched')
	const heldWhileOrdering = await page.evaluate(() => globalThis.latchedCtrlWhenOrdered === true)
	const latched = record('right click with Ctrl latched down in key state but not in the press',
		latchedCall, { expect: 'Move', forbid: ['Attack', 'ForceAttack'], modifierBit: false })
	if (!heldWhileOrdering)
		fail('the latched ControlLeft was not still down when the order reached the bridge, so the case proved nothing')
	const stillLatched = await page.evaluate(() => steelseed.ctx.input.ctrl)
	if (stillLatched) fail('the latched-key case left Ctrl down; later cases would be contaminated')

	if (pageErrors.length) fail(`page errors during the run: ${pageErrors.slice(0, 3).join(' | ')}`)

	console.log(findings.map(line => `${TOOL}: ${line}`).join('\n'))
	console.log(`${TOOL}: PASS — plain right click stays ${move.names.join(',')} on ground and ` +
		`${friendlyPlain.names.join(',') || 'nothing'} on a friendly; Ctrl forces Attack in both places ` +
		`(${forceGround.names.join(',')} / ${friendlyForced.names.join(',')})` +
		`${group
			? `; a two-unit group travels as one request and OpenRA answers per actor (${group.names.join('+')}, ${group.result.match(/issued \d+\/\d+/)?.[0]})`
			: '; the group case was NOT exercised (no unarmed second actor in this fixture)'}; ` +
		`${enter
			? `a ${passenger.name} right-clicked onto a ${transport.name} still resolves ${enter.names.join(',')}; `
			: 'the enter path was NOT exercised (this fixture has no transport; cargogate covers it); '}` +
		`a blur-cleared Ctrl still forces Attack (${afterBlur.names.join(',')}); ` +
		`and a Ctrl latched down in key state but absent from the press stays ${latched.names.join(',')}, ` +
		`so the press decides in both directions`)
} finally {
	await browser.close()
}
