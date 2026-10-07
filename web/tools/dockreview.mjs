#!/usr/bin/env node
// Staged art review of the refinery dock and the radar, through the shipping renderer.
// NOT an acceptance fixture: it exists so the dock enclosure, the eave seam and the
// radome can be looked at from the pitch the camera actually clamps to.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, '.artifacts/dock-review')
const label = process.argv.find(a => a.startsWith('--label='))?.slice(8) ?? 'dock'
const tod = Number(process.argv.find(a => a.startsWith('--tod='))?.slice(6) ?? 660)
if (!Number.isFinite(tod) || tod < 0 || tod >= 1440) throw new Error('--tod must be minutes in [0, 1440)')
const preview = await startPreview(8471)
let browser
try {
	({ browser } = await launchGpuBrowser(await loadChromium('dockreview'), 'dockreview'))
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
	const errors = []
	page.on('pageerror', e => errors.push(e.message))
	page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()) })
	await page.addInitScript(() => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {} })
	await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&devsize=48&devactors=4&devtod=${tod}&weather=clear&quality=ultra`)
	await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
	// Camera rigs: the pitch the game clamps to at each height, plus one hero angle.
	// pitch = 48 deg at height 3.5 and 62 deg at height 140, linear in height.
	const RIGS = [
		{ id: 'far-topdown', height: 30, yaw: 0.0, tx: 24.0, tz: 22.0 },
		{ id: 'near-3q', height: 6.0, yaw: 0.0, tx: 24.0, tz: 22.6 },
		{ id: 'near-outboard', height: 6.0, yaw: Math.PI, tx: 24.0, tz: 22.6 },
		{ id: 'eave-edge', height: 5.0, yaw: Math.PI * 0.5, tx: 24.0, tz: 22.4 },
		{ id: 'radar', height: 5.0, yaw: 0.4, tx: 28.0, tz: 22.0 },
	]
	const shots = await page.evaluate(async (RIGS) => {
		const app = globalThis.steelseed
		app.stop(); app.renderOneFrame(0); app.bridge = null
		const ctx = app.ctx, units = ctx.get('units'), terrain = ctx.get('terrain'), shroud = ctx.get('shroud')
		const render = ctx.get('render'), cam = ctx.get('camera')
		const snap = ctx.snapshot, ground = snap.terrainStatic
		ground.height.fill(0); ground.ramp.fill(0); ground.surface.fill(4); ground.resource.fill(0)
		terrain.onSnapshot(snap, null, ctx)
		shroud.cells.fill(2); render.setShroud(shroud.cells, ground.w, ground.h, 0, 0)
		// PROC CenterPosition sits at footprint cell (1.5,1.5); the dock is one cell SOUTH,
		// so a harvester parked at the dock is the refinery's position + (0, 1) cells,
		// facing 256 (DockAngle) exactly as DockHost puts it.
		const names = ['proc', 'harv', 'dome', 'domf']
		const at = [[24, 22], [24, 23], [28, 22], [28, 25]]
		const facing = [0, 256, 0, 0]
		const a = snap.actors
		for (let i = 0; i < a.count; i++) {
			const k = i % names.length
			a.typeId[i] = i + 3000; a.posX[i] = at[k][0] * 1024; a.posY[i] = at[k][1] * 1024; a.posZ[i] = 0
			a.health[i] = 255; a.owner[i] = 0; a.flags[i] = 0; a.facing[i] = facing[k]
			units.typeSlot.set(a.typeId[i], names[k]); units.typeClass.set(a.typeId[i], 0)
			units.typeVehicle.set(a.typeId[i], k === 1)
			units.typeRenderable.set(a.typeId[i], true); units.typeWatercraft.set(a.typeId[i], false)
			units.typeWaterStructure.set(a.typeId[i], false)
		}
		units.onSnapshot(snap, null, ctx)
		units.living.spawns.length = 0
		const results = []
		for (const rig of RIGS) {
			cam.height = cam.heightGoal = rig.height
			cam.yaw = cam.yawGoal = rig.yaw
			cam.target[0] = cam.targetGoal[0] = rig.tx
			cam.target[2] = cam.targetGoal[2] = rig.tz
			for (let i = 1; i <= 40; i++) app.renderOneFrame(i * 1000 / 60)
			const copy = document.createElement('canvas')
			copy.width = ctx.canvas.width; copy.height = ctx.canvas.height
			copy.getContext('2d').drawImage(ctx.canvas, 0, 0)
			results.push({ id: rig.id, png: copy.toDataURL('image/png'),
				pitchDeg: Math.atan2(cam.height, Math.hypot(cam.eye[0] - cam.target[0], cam.eye[2] - cam.target[2])) * 180 / Math.PI })
		}
		return { results, counts: names.map(n => ({ n, c: units.slotBuckets.get(n)?.count ?? 0 })), triangles: render.stats.triangles }
	}, RIGS)
	mkdirSync(out, { recursive: true })
	for (const s of shots.results)
		writeFileSync(join(out, `${label}-${s.id}.png`), Buffer.from(s.png.split(',')[1], 'base64'))
	console.log('dockreview:', JSON.stringify({ label, tod, counts: shots.counts,
		pitches: shots.results.map(s => ({ id: s.id, pitchDeg: +s.pitchDeg.toFixed(2) })), errors: errors.slice(0, 5) }))
	if (errors.length) { console.error('PAGE ERRORS', errors.slice(0, 5)); process.exitCode = 1 }
} finally { await browser?.close(); await stopChild(preview.server) }
