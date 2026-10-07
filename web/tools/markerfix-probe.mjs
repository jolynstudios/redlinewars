#!/usr/bin/env node
// THROWAWAY probe for the marker-fix pass. Not a gate; deleted after evidence.
// Drives the real composed AppBundle host on 127.0.0.1:8090 and captures the host
// bridge's own resolved-order diagnostics.
//
// Usage: node tools/markerfix-probe.mjs --phase=pre|post [--outdir=DIR]

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'

const TOOL = 'markerfix-probe'
const flags = new Map(process.argv.slice(2).map(arg => {
	const [key, ...rest] = arg.replace(/^--/, '').split('=')
	return [key, rest.length > 0 ? rest.join('=') : '1']
}))
const phase = flags.get('phase') ?? 'pre'
const pinnedMap = flags.get('map') ?? null
const outdir = resolve(fileURLToPath(new URL('..', import.meta.url)), '..', flags.get('outdir') ?? `.artifacts/planx/marker-fix/${phase}`)
const baseUrl = flags.get('url') ?? 'http://127.0.0.1:8090/steelseed/index.html'
mkdirSync(outdir, { recursive: true })

const chromium = await loadChromium(TOOL)
const launched = await launchGpuBrowser(chromium, TOOL)
const browser = launched.browser
const summary = { phase, results: null, shots: [], errors: [], mapsTried: [] }
let context = null

try {
	context = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 1 })
	const page = await context.newPage()
	page.on('pageerror', e => summary.errors.push('pageerror: ' + e))
	page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource:/.test(m.text())) summary.errors.push(m.text()) })

	const startOnMap = async uid => {
		const url = new URL(baseUrl)
		url.searchParams.set('mode', 'game')
		url.searchParams.set('platform', 'null')
		url.searchParams.set('Debug.ServerRandomSeed', '104729')
		url.searchParams.set('cb', String(Date.now()))
		await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(() => globalThis.steelseed !== undefined && globalThis.ora !== undefined && globalThis.steelseedBridge !== undefined,
			undefined, { timeout: 120000, polling: 100 })
		await page.waitForFunction(() => {
			const sel = document.getElementById('session-map')
			return sel !== null && sel.options.length > 0
		}, undefined, { timeout: 60000, polling: 200 })
		if (uid !== null) {
			const ok = await page.evaluate(mapUid => {
				const sel = document.getElementById('session-map')
				sel.value = mapUid
				sel.dispatchEvent(new Event('change', { bubbles: true }))
				return sel.value === mapUid
			}, uid)
			if (!ok) return false
		}
		await page.click('#session-start')
		await page.waitForFunction(() => {
			const app = globalThis.steelseed
			return app.ctx.snapshot?.actors?.count > 0 && app.ctx.snapshot?.players?.length > 0 &&
				document.getElementById('game-ui').hidden === false && document.getElementById('session-ui').hidden
		}, undefined, { timeout: 120000, polling: 100 })
		return true
	}

	// Pick a map that actually carries tree scenery: prefer tree-ish labels, verify the
	// live snapshot, and fall through the catalog until one qualifies.
	const options = await startOnMap(null)
		? await page.evaluate(() => [...document.querySelectorAll('#session-map option')].map(o => ({ uid: o.value, label: o.textContent })))
		: []
	summary.mapsTried = options.map(o => o.uid)
	const preferred = pinnedMap !== null ? [pinnedMap] : options
		.filter(o => /tree|forest|wood|grove|park|path|green|leaf/i.test(o.label))
		.map(o => o.uid)
		.concat(options.map(o => o.uid))
	let mapUsed = pinnedMap
	for (const uid of (pinnedMap === null ? preferred.slice(0, 12) : preferred)) {
		if (!(await startOnMap(uid))) continue
		const trees = await page.evaluate(() => {
			const app = globalThis.steelseed
			const units = app.ctx.get('units')
			const snap = app.ctx.snapshot
			const treeName = name => !units.hasRaTrait(name, 'Selectable') &&
				(/tree/i.test(units.displayName(name) ?? '') || units.semanticRole(name) === 'terrain-object')
			let count = 0
			for (let i = 0; i < snap.actors.count; i++) if (treeName(app.ctx.actorTypeName(snap.actors.typeId[i]))) count++
			const frozen = snap.frozenActors
			if (frozen) for (let i = 0; i < frozen.count; i++) if (treeName(app.ctx.actorTypeName(frozen.typeId[i]))) count++
			return count
		})
		if (trees > 0) { mapUsed = uid; break }
	}
	// Trees only gate the marker/tree CASES, not the pick/guard/rally evidence: if no
	// candidate map carries scenery, continue on the first map and note the skip.
	if (mapUsed === null) {
		mapUsed = options[0]?.uid ?? null
		summary.treelessRun = true
	}
	if (!(await startOnMap(mapUsed))) throw new Error('final match start failed on ' + mapUsed)
	summary.mapUsed = mapUsed
	const results = await page.evaluate(async () => {
		const app = globalThis.steelseed
		const ui = app.ctx.get('ui')
		const canvas = app.ctx.canvas
		const rect = canvas.getBoundingClientRect()
		const sleep = ms => new Promise(r => setTimeout(r, ms))
		const unitsNode = app.ctx.get('units')
		const out = { bootstrap: {}, pick: {}, placement: {}, cases: {}, ctxCalls: null }
		const log = []
		const snapNow = () => app.ctx.snapshot
		const renderPlayer = () => snapNow().world.renderPlayer

		// The dotnet JSExport bridge object is immutable (property writes are ignored in
		// sloppy mode), so capture at the client seam instead: every UI order crosses
		// app.ctx.issueOrder with its full request shape.
		globalThis.__bridgeCalls = []
		const origCtxIssue = app.ctx.issueOrder.bind(app.ctx)
		app.ctx.issueOrder = o => {
			globalThis.__bridgeCalls.push({
				orderString: o.orderString,
				contextual: o.contextual === true,
				subjectCount: o.subjectCount ?? o.subjectIds.length,
				subjects: Array.from(o.subjectIds).slice(0, o.subjectCount ?? o.subjectIds.length),
				targetActorId: o.targetActorId ?? 0,
				targetCell: o.targetCell ? { ...o.targetCell } : null,
			})
			return origCtxIssue(o)
		}

		const project = (wx, wy, wz) => {
			const vp = app.ctx.get('render').camera.viewProj
			const w = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15]
			if (w <= 0) return null
			return {
				x: ((vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / w * 0.5 + 0.5) * rect.width,
				y: (0.5 - (vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / w * 0.5) * rect.height,
			}
		}
		const findActor = pred => {
			const snap = snapNow()
			for (let i = 0; i < snap.actors.count; i++) {
				if (!pred(snap, i, app.ctx.actorTypeName(snap.actors.typeId[i]))) continue
				return { id: snap.actors.id[i], index: i, owner: snap.actors.owner[i], x: snap.actors.posX[i] / 1024, z: snap.actors.posY[i] / 1024 }
			}
			return null
		}
		const findActors = pred => {
			const snap = snapNow()
			const found = []
			for (let i = 0; i < snap.actors.count; i++) {
				if (!pred(snap, i, app.ctx.actorTypeName(snap.actors.typeId[i]))) continue
				found.push({ id: snap.actors.id[i], index: i, owner: snap.actors.owner[i], x: snap.actors.posX[i] / 1024, z: snap.actors.posY[i] / 1024 })
			}
			return found
		}
		const groundProject = a => project(a.x, app.ctx.get('terrain').heightAt(a.x, a.z) + 1.0, a.z)
		const press = (px, py, button) => {
			canvas.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerId: 1 }))
			canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: px, clientY: py }))
			canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button, clientX: px, clientY: py, buttons: button === 2 ? 2 : 1 }))
			canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button, clientX: px, clientY: py }))
		}
		const tapKey = code => {
			const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code
			window.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true }))
			window.dispatchEvent(new KeyboardEvent('keyup', { code, key, bubbles: true }))
		}
		const markerState = () => ({
			marker: ui.orderMarker ? { attack: ui.orderMarker.attack, reachable: ui.orderMarker.reachable, active: ui.orderMarker.active } : null,
			ringShown: ui.orderMarkerRing?.style.display !== 'none',
			ringStroke: ui.orderMarkerRing?.getAttribute('stroke'),
			reticleShown: ui.orderMarkerReticle?.style.display !== 'none',
			reticleD: ui.orderMarkerReticle?.getAttribute('d'),
			dotShown: ui.orderMarkerDot?.style.display !== 'none',
		})
		const selectOnly = async id => {
			ui.selection.length = 0
			if (id >= 0) ui.selection.push(id)
			ui.onSnapshot(snapNow(), null, app.ctx)
			await sleep(250)
		}
		const isTreeName = name => !unitsNode.hasRaTrait(name, 'Selectable') &&
			(/tree/i.test(unitsNode.displayName(name) ?? '') || unitsNode.semanticRole(name) === 'terrain-object')
		const hudItems = () => [...document.querySelectorAll('#hud-queues .hud-item')]
		const waitForReadyBuilding = async match => {
			const producer = findActor((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.productionKind(name) >= 0)
			if (!producer) return { error: 'no own producer' }
			await selectOnly(producer.id)
			let item = hudItems().find(b => b.dataset.building === '1' && !b.disabled &&
				(!match || match.test(b.textContent ?? '') || match.test(b.dataset.actorName ?? '')))
			if (!item) item = hudItems().find(b => b.dataset.building === '1' && !b.disabled)
			if (!item) return { error: 'no buildable structure item', buttons: hudItems().map(b => b.textContent) }
			item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
			const deadline = Date.now() + 240000
			while (Date.now() < deadline) {
				const ready = hudItems().find(b => b.dataset.ready === '1' && b.dataset.building === '1')
				if (ready) {
					ready.dispatchEvent(new MouseEvent('click', { bubbles: true }))
					await sleep(150)
					return { producerId: producer.id, armed: ui.pendingPlacement !== null, actorName: ui.pendingPlacement?.actorName ?? null }
				}
				await sleep(500)
			}
			return { error: 'building never became ready' }
		}
		const fineCellAt = (px, py) => {
			const camera2 = app.ctx.get('camera')
			const w = canvas.clientWidth, h = canvas.clientHeight
			if (!camera2.picker.setRay(camera2.view, camera2.proj, camera2.eye, px, py, w, h)) return null
			const o = camera2.picker.origin, d = camera2.picker.direction
			if (d[1] >= -1e-6) return null
			const terrain = app.ctx.get('terrain')
			const sample = t => (o[1] + d[1] * t) - terrain.heightAt(o[0] + d[0] * t, o[2] + d[2] * t)
			let prevT = 0
			let t = 0.0625
			if (sample(0) < 0) {
				let emerged = false
				for (; t <= 4096; t += 0.0625) {
					if (sample(t) > 0) { prevT = t; t += 0.0625; emerged = true; break }
					prevT = t
				}
				if (!emerged) return null
			}
			for (; t <= 4096; t += 0.0625) {
				if (sample(t) <= 0) {
					let lo = prevT, hi = t
					for (let i = 0; i < 14; i++) {
						const mid = (lo + hi) * 0.5
						if (sample(mid) > 0) lo = mid; else hi = mid
					}
					const ft = (lo + hi) * 0.5
					return { cellX: Math.floor(o[0] + d[0] * ft), cellY: Math.floor(o[2] + d[2] * ft) }
				}
				prevT = t
			}
			return null
		}
		const tryPlaceNearBase = async () => {
			const base = findActor((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.productionKind(name) >= 0)
			const camera = app.ctx.get('camera')
			if (!base) return []
			const baseScreen = groundProject(base)
			const candidates = [[0, 0], [0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05], [0.04, 0.04], [-0.04, -0.04]]
			const attempts = []
			for (const [dx, dy] of candidates) {
				const px = Math.round(rect.left + baseScreen.x + dx * rect.width)
				const py = Math.round(rect.top + baseScreen.y + dy * rect.height)
				const cell = camera.pickGroundCell(px, py, app.ctx)
				const fine = fineCellAt(px, py)
				if (!cell) continue
				const near = Math.abs(cell.x - base.x) <= 6 && Math.abs(cell.y - base.z) <= 6
				if (!near) continue
				canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: px, clientY: py }))
				await sleep(180)
				const previewStatus = ui.placementResult?.status ?? null
				const previewValid = ui.placementResult?.cells?.every?.(c => c.valid) ?? null
				canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: px, clientY: py, buttons: 1 }))
				await sleep(150)
				canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0, clientX: px, clientY: py }))
				await sleep(300)
				attempts.push({ px: +(px - rect.left).toFixed(0), py: +(py - rect.top).toFixed(0), cell, fine, previewStatus, previewValid, issued: ui.placementResult?.issued ?? null, status: ui.placementResult?.status ?? null, stillArmed: ui.pendingPlacement !== null })
				if (ui.pendingPlacement === null) break
			}
			return attempts
		}

		// ---------- bootstrap: deploy MCV into a producer ----------
		{
			const firstOwn = findActor((s, i) => s.actors.owner[i] === renderPlayer())
			if (firstOwn) await selectOnly(firstOwn.id)
			const deploy = document.getElementById('hud-deploy')
			if (deploy && !deploy.hidden) deploy.dispatchEvent(new MouseEvent('click', { bubbles: true }))
			const deadline = Date.now() + 30000
			while (Date.now() < deadline && !findActor((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.productionKind(name) >= 0)) await sleep(400)
			out.bootstrap.producer = findActor((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.productionKind(name) >= 0)?.id ?? null
			if (out.bootstrap.producer === null) return { ...out, fatal: 'bootstrap: deploy did not yield a producer' }
			log.push('bootstrap ok')
		}

		// ---------- Part B: pick fidelity + placement ----------
		out.pick.meshCheck = await (async () => {
			const terrain = app.ctx.get('terrain')
			const camera = app.ctx.get('camera')
			camera.tiltGoal = -0.35
			camera.heightGoal = 26
			await sleep(1800)
			let maxAbsDiff = 0
			const worst = []
			const world = snapNow().world
			for (let n = 0; n < 400; n++) {
				const gx = world.boundsLeft + 4 + ((n * 37) % Math.max(1, Math.min(48, world.boundsRight - world.boundsLeft - 8)))
				const gz = world.boundsTop + 4 + ((n * 53) % Math.max(1, Math.min(48, world.boundsBottom - world.boundsTop - 8)))
				for (const [fx, fz] of [[0.3, 0.4], [0.7, 0.8], [0.5, 0.5]]) {
					const x = gx + fx, z = gz + fz
					const bx = Math.floor(x), bz = Math.floor(z)
					const u = x - bx, v = z - bz
					const h00 = terrain.heightAt(bx, bz), h10 = terrain.heightAt(bx + 1, bz)
					const h01 = terrain.heightAt(bx, bz + 1), h11 = terrain.heightAt(bx + 1, bz + 1)
					const mesh = v >= u ? h00 * (1 - v) + h01 * (v - u) + h11 * u : h00 * (1 - u) + h11 * v + h10 * (u - v)
					const diff = Math.abs(mesh - terrain.heightAt(x, z))
					if (diff > maxAbsDiff) maxAbsDiff = diff
					if (diff > 0.05 && worst.length < 8) worst.push({ x, z, diff: +diff.toFixed(3) })
				}
			}
			return { maxAbsDiff: +maxAbsDiff.toFixed(3), worst }
		})()
		const pickGrid = async (tilt, height, settle) => {
			const camera = app.ctx.get('camera')
			camera.tiltGoal = tilt
			camera.heightGoal = height
			await sleep(settle)
			let diffs = 0, samples = 0, nullCoarse = 0, maxCellDist = 0
			const diffSamples = []
			for (let gy = 0.12; gy < 0.95; gy += 0.11) for (let gx = 0.08; gx < 0.92; gx += 0.1) {
				samples++
				const px = Math.round(rect.left + gx * rect.width), py = Math.round(rect.top + gy * rect.height)
				const coarse = app.ctx.get('camera').pickGroundCell(px, py, app.ctx)
				const fine = fineCellAt(px, py)
				if (!coarse) nullCoarse++
				if (coarse && fine && (coarse.x !== fine.cellX || coarse.y !== fine.cellY)) {
					diffs++
					const dist = Math.hypot(coarse.x + 0.5 - (fine.cellX + 0.5), coarse.y + 0.5 - (fine.cellY + 0.5))
					maxCellDist = Math.max(maxCellDist, dist)
					if (diffSamples.length < 8) diffSamples.push({ gx: +gx.toFixed(2), gy: +gy.toFixed(2), coarse, fine })
				}
			}
			return { diffs, samples, nullCoarse, maxCellDist: +maxCellDist.toFixed(2), diffSamples }
		}
		out.pick.level = await pickGrid(0, 90, 1800)
		out.pick.tilted = await pickGrid(-0.35, 26, 2200)
		{
			const camera = app.ctx.get('camera')
			camera.tiltGoal = 0
			camera.heightGoal = 60
			await sleep(1800)
			const armTop = await waitForReadyBuilding(/power|plant|powr/i)
			out.placement.topDownArm = armTop
			if (armTop.armed) {
				out.placement.topDown = await tryPlaceNearBase()
				log.push('topDown ' + out.placement.topDown.map(a => `${a.issued}/${a.status}/pick=${a.cell.x},${a.cell.y}`).join(' | '))
			}
			camera.tiltGoal = -0.35
			camera.heightGoal = 26
			await sleep(2200)
			const tiltedRounds = []
			for (let round = 0; round < 3; round++) {
				const arm = await waitForReadyBuilding(/power|plant|powr/i)
				if (!arm.armed) { tiltedRounds.push({ round, arm }); break }
				const attempts = await tryPlaceNearBase()
				tiltedRounds.push({ round, actorName: arm.actorName, attempts })
				log.push(`tilted r${round} ` + attempts.map(a => `${a.issued}/${a.status}/pick=${a.cell.x},${a.cell.y}/fine=${a.fine ? `${a.fine.cellX},${a.fine.cellY}` : 'null'}`).join(' | '))
			}
			out.placement.tiltedRounds = tiltedRounds
		}

		// ---------- bootstrap 2: barracks (top-down) → two riflemen ----------
		let combat = findActors((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.hasRaTrait(name, 'Armament'))
		if (combat.length === 0) {
			const camera = app.ctx.get('camera')
			camera.tiltGoal = 0
			camera.heightGoal = 60
			await sleep(1800)
			let placed = false
			for (let round = 0; round < 3 && !placed; round++) {
				const arm = await waitForReadyBuilding(/barr|tent|kazern|infan|recruit|train/i)
				log.push(`barracks arm=${JSON.stringify(arm)}`)
				// The matcher's fallback may arm a power plant: that is not an infantry
				// structure, so cancel and retry rather than waste the round on it.
				if (!arm.armed || !/^barr|^tent/i.test(arm.actorName ?? '')) {
					if (arm.armed) ui.cancelPlacement()
					await sleep(5000)
					continue
				}
				const attempts = await tryPlaceNearBase()
				placed = attempts.some(a => !a.stillArmed)
				log.push(`barracks place=${placed}`)
			}
			if (placed) {
				const deadline = Date.now() + 120000
				while (Date.now() < deadline) {
					const barracks = findActor((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.productionKind(name) > 0)
					if (barracks) {
						await selectOnly(barracks.id)
						const item = hudItems().find(b => !b.disabled && b.dataset.building !== '1')
						log.push(`infantry item=${item ? item.textContent : 'none'}`)
						if (item) { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(300); item.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
						break
					}
					await sleep(500)
				}
				const deadline2 = Date.now() + 240000
				while (Date.now() < deadline2 && findActors((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.hasRaTrait(name, 'Armament')).length < 2) await sleep(500)
				combat = findActors((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.hasRaTrait(name, 'Armament'))
			}
		}
		out.combatUnits = combat.map(c => ({ id: c.id, x: +c.x.toFixed(2), z: +c.z.toFixed(2) }))
		if (combat.length === 0) return { ...out, fatal: 'no own armed unit obtainable after base build', log }

		// ---------- Part A: marker + tree cases near a foreign tree ----------
		{
			const trees = findActors((s, i, name) => isTreeName(name))
			trees.sort((a, b) => a.dist !== undefined ? 0 : 0)
			out.treeCount = trees.length
			out.treeOwners = [...new Set(trees.map(t => t.owner))]
			if (trees.length > 0) {
				const tree = trees[0]
				app.ctx.get('camera').focusWorld(tree.x, tree.z)
				await sleep(1200)
				const treeScreen = groundProject(tree)
				out.tree = { id: tree.id, owner: tree.owner, x: tree.x, z: tree.z }

				// CASE A1 (bug1 control): right-click open ground away from actors.
				await selectOnly(combat[0].id)
				press(rect.left + rect.width * 0.5, rect.top + rect.height * 0.62, 2)
				await sleep(150)
				out.cases.moveOpenGround = markerState()

				// CASE A2 (bug1): right-click open ground beside the tree (within 44 px).
				await selectOnly(combat[0].id)
				press(rect.left + treeScreen.x + 34, rect.top + treeScreen.y + 20, 2)
				await sleep(150)
				out.cases.moveNearTree = { ...markerState(), clickPx: { x: treeScreen.x + 34, y: treeScreen.y + 20 } }

				// CASE A4 (bug3): left-click the tree.
				ui.selection.length = 0
				ui.onSnapshot(snapNow(), null, app.ctx)
				await sleep(120)
				press(rect.left + treeScreen.x, rect.top + treeScreen.y, 0)
				await sleep(150)
				out.cases.clickTree = {
					selection: [...ui.selection],
					hudName: document.getElementById('hud-selection-name')?.textContent,
					hudDetail: document.getElementById('hud-selection-detail')?.textContent,
					notice: document.getElementById('hud-notice')?.textContent,
				}
			}

			// CASE A5 (bug3 control): own combat unit still selectable.
			ui.selection.length = 0
			ui.onSnapshot(snapNow(), null, app.ctx)
			await sleep(120)
			const cs = groundProject(combat[0])
			press(rect.left + cs.x, rect.top + cs.y, 0)
			await sleep(150)
			out.cases.clickOwnUnit = {
				selection: [...ui.selection],
				hudName: document.getElementById('hud-selection-name')?.textContent,
			}
		}

		// ---------- Part C: guard on a moving friendly Guardable unit ----------
		if (combat.length >= 2) {
			const mover = combat[1]
			// Select the mover and right-click far ground so it is genuinely walking.
			await selectOnly(mover.id)
			press(rect.left + rect.width * 0.5, rect.top + rect.height * 0.3, 2)
			await sleep(120)
			await selectOnly(combat[0].id)
			const ms = groundProject(mover)
			canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: rect.left + ms.x, clientY: rect.top + ms.y }))
			await sleep(100)
			const before = globalThis.__bridgeCalls.length
			tapKey('KeyG')
			await sleep(250)
			out.cases.guardOnGuardable = {
				calls: globalThis.__bridgeCalls.slice(before),
				movingFlag: (() => { const s = snapNow(); for (let i = 0; i < s.actors.count; i++) if (s.actors.id[i] === mover.id) return (s.actors.flags[i] & 1) !== 0; return null })(),
			}
			// Non-Guardable fallback: the construction yard carries Production but no
			// Guardable trait, so G on it must fall through to the guard-area stance+move.
			{
				const producer = findActor((s, i, name) => s.actors.owner[i] === renderPlayer() &&
					!unitsNode.hasRaTrait(name, 'Guardable'))
				if (producer) {
					app.ctx.get('camera').focusWorld(producer.x, producer.z)
					await sleep(900)
					const ps = groundProject(producer)
					canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: rect.left + ps.x, clientY: rect.top + ps.y }))
					await sleep(100)
					const mark = globalThis.__bridgeCalls.length
					tapKey('KeyG')
					await sleep(300)
					out.cases.guardOnNonGuardable = {
						target: producer.id,
						calls: globalThis.__bridgeCalls.slice(mark),
					}
				}
			}
		}

		// ---------- Part D: rally point from the barracks ----------
		{
			const barracks = findActor((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.productionKind(name) > 0)
				?? findActor((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.hasRaTrait(name, 'RallyPoint'))
			if (!barracks) out.cases.rally = { error: 'no rally building' }
			else {
				await selectOnly(barracks.id)
				// Right-click ground a good distance from the building.
				const rx = barracks.x + 10, rz = barracks.z + 8
				app.ctx.get('camera').focusWorld(barracks.x, barracks.z)
				await sleep(900)
				const rp = project(rx, app.ctx.get('terrain').heightAt(rx, rz) + 0.2, rz)
				const mark = globalThis.__bridgeCalls.length
				press(rect.left + rp.x, rect.top + rp.y, 2)
				await sleep(250)
				const rallyCalls = globalThis.__bridgeCalls.slice(mark)
				out.cases.rally = {
					calls: rallyCalls,
					uiRallyPoints: [...(ui.rallyPoints ? ui.rallyPoints : [])].map(([k, v]) => ({ id: k, x: v.x, z: v.z })),
				}
				// Route proof: queue a rifle and watch it close on the rally cell.
				const item = hudItems().find(b => !b.disabled && b.dataset.building !== '1')
				if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
				const known = new Set(findActors((s, i, name) => s.actors.owner[i] === renderPlayer()).map(a => a.id))
				const deadline = Date.now() + 120000
				let recruit = null
				while (Date.now() < deadline) {
					const fresh = findActors((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.hasRaTrait(name, 'Armament')).find(a => !known.has(a.id))
					if (fresh) { recruit = fresh; break }
					await sleep(500)
				}
				if (!recruit) { out.cases.rally.route = { error: 'no recruit spawned' } }
				else {
					const d0 = Math.hypot(recruit.x - rx, recruit.z - rz)
					await sleep(7000)
					const after = findActors((s, i, name) => s.actors.owner[i] === renderPlayer() && unitsNode.hasRaTrait(name, 'Armament')).find(a => a.id === recruit.id)
					const d1 = after ? Math.hypot(after.x - rx, after.z - rz) : null
					out.cases.rally.route = { recruitId: recruit.id, distStart: +d0.toFixed(2), distAfter7s: d1 === null ? null : +d1.toFixed(2) }
				}
			}
		}

		// ---------- Part E: support power fire keeps the sim alive ----------
		{
			const powers = (typeof app.ctx.supportPowers === 'function' ? app.ctx.supportPowers() : null) ?? []
			out.supportPowers = powers
			const button = document.querySelector('#hud-support button[data-power], button[data-power]')
			if (button) {
				button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
				await sleep(200)
			} else if (powers.length > 0) {
				ui.supportPowerArmed = powers[0].order ?? powers[0].id ?? null
			}
			if (ui.supportPowerArmed !== null && powers.length > 0) {
				const mark = globalThis.__bridgeCalls.length
				press(rect.left + rect.width * 0.55, rect.top + rect.height * 0.5, 0)
				await sleep(400)
				const fireCalls = globalThis.__bridgeCalls.slice(mark)
				const t0 = snapNow().tick
				await sleep(4000)
				const t1 = snapNow().tick
				out.cases.supportFire = {
					armed: powers.map(p => p.order ?? p.id),
					calls: fireCalls,
					tickBefore: t0, tickAfter: t1, simAlive: t1 > t0 + 50,
				}
			} else {
				out.cases.supportFire = { note: 'no support power granted in this match', armed: [] }
			}
		}


		out.ctxCalls = globalThis.__bridgeCalls.slice(-40)
		out.log = log
		return out
	}, { timeout: 560000 })

	summary.results = results
	await page.screenshot({ path: `${outdir}/final-view.png` })
	summary.shots.push('final-view.png')
	await context.close()
	context = null
} catch (error) {
	summary.fatal = String(error && error.stack || error)
} finally {
	if (context) await context.close()
	await browser.close()
}

writeFileSync(`${outdir}/summary.json`, JSON.stringify(summary, null, 2))
const r = summary.results
if (r) {
	console.log(`${TOOL}[${phase}]: bootstrap=${JSON.stringify(r.bootstrap)} combat=${JSON.stringify(r.combatUnits)} trees=${JSON.stringify(r.treeCount)}`)
	console.log(`${TOOL}[${phase}]: meshCheck=${JSON.stringify(r.pick.meshCheck)}`)
	console.log(`${TOOL}[${phase}]: pickLevel=${JSON.stringify(r.pick.level)}`)
	console.log(`${TOOL}[${phase}]: pickTilted=${JSON.stringify(r.pick.tilted)}`)
	console.log(`${TOOL}[${phase}]: placement=${JSON.stringify(r.placement)}`)
	console.log(`${TOOL}[${phase}]: moveOpenGround=${JSON.stringify(r.cases.moveOpenGround)}`)
	console.log(`${TOOL}[${phase}]: moveNearTree=${JSON.stringify(r.cases.moveNearTree)}`)
	console.log(`${TOOL}[${phase}]: clickTree=${JSON.stringify(r.cases.clickTree)}`)
	console.log(`${TOOL}[${phase}]: clickOwnUnit=${JSON.stringify(r.cases.clickOwnUnit)}`)
	console.log(`${TOOL}[${phase}]: guardOnGuardable=${JSON.stringify(r.cases.guardOnGuardable)}`)
	console.log(`${TOOL}[${phase}]: guardOnNonGuardable=${JSON.stringify(r.cases.guardOnNonGuardable)}`)
	console.log(`${TOOL}[${phase}]: rally=${JSON.stringify(r.cases.rally)}`)
	console.log(`${TOOL}[${phase}]: log=${JSON.stringify(r.log)}`)
} else {
	console.log(`${TOOL}[${phase}]: no results`, summary.fatal ?? '')
}
if (summary.fatal) { console.error(`${TOOL}: FATAL ${summary.fatal}`); process.exit(1) }
