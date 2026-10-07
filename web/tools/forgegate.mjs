#!/usr/bin/env node
// Production GPU loading and graceful fallback for the complete Blender roster.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'
import { decodePng } from './png.mjs'

const web = fileURLToPath(new URL('..', import.meta.url))
const preview = await startPreview(8416)
let browser
const falsify = process.argv.includes('--falsify=zero')
try {
	;({ browser } = await launchGpuBrowser(await loadChromium('forgegate'), 'forgegate'))
	const baked = await capture(false)
	assert.deepEqual(baked.dropped, [], `Every authored mesh must upload: ${baked.warnings.join('\n')}`)
	if (falsify) baked.stats.loaded = 0
	assert.equal(baked.stats.available, 277, JSON.stringify(baked.stats))
	assert.equal(baked.stats.loaded, 277, JSON.stringify(baked.stats))
	assert.equal(baked.stats.fallback, 0)
	assert.deepEqual(baked.stats.errors, [])
	assert.equal(baked.stats.hidden, 6)
	const staticHost = await capture(false, true)
	assert.equal(staticHost.stats.loaded, 277, JSON.stringify(staticHost.stats))
	assert.deepEqual(staticHost.stats.errors, [])
	const fallback = await capture(true)
	// noforge disables the ROSTER pack. The anatomical infantry pack loads independently
	// of it, so its two slots (e1, e3) still draw authored: the roster's remaining 275
	// are what must fall back to the procedural class hulls.
	assert.equal(fallback.stats.loaded + fallback.stats.fallback, 277, JSON.stringify(fallback.stats))
	assert.ok(fallback.stats.fallback > 200, JSON.stringify(fallback.stats))
	// The baked 2tnk binds its per-asset material set - the industrial-v1 binding that
	// replaced the shared palette index - so its surfaceSet names that binding.
	assert.equal(baked.surface, 'industrial-v1:2tnk')
	assert.notEqual(fallback.surface, 'blender')
	assert.equal(baked.lods.length, 3)
	assert.ok(baked.lods[0] >= baked.lods[1] && baked.lods[1] >= baked.lods[2])
	assert.ok(baked.active > 0 && fallback.active > 0, 'the selected tank must actually be drawn')
	mkdirSync(join(web, 'shots'), { recursive: true })
	writeFileSync(join(web, 'shots/blender-in-engine.png'), baked.png)
	writeFileSync(join(web, 'shots/blender-procedural-fallback.png'), fallback.png)
	const a = decodePng(baked.png), b = decodePng(fallback.png)
	let changed = 0
	for (let i = 0; i < a.data.length; i += 4)
		if (Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2]) > 12) changed++
	assert.ok(changed > 100, `Blender and procedural geometry must produce different visible frames (${changed})`)
	console.log(`forgegate: PASS — 277 Blender meshes loaded through both automatic HTTP and in-browser gzip decompression, 0 fallback/errors; three GPU LODs; disabled pack restores 277 procedural meshes; ${changed} visibly changed pixels`)
} finally { await browser?.close(); await stopChild(preview.server) }

async function capture(noforge, staticHost = false) {
	const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })
	const errors = []
	const warnings = []
	page.on('pageerror', e => errors.push(e.message))
	page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()) })
	page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()) })
	if (staticHost) await page.route('**/roster.ssasset-*.gz', route => route.fulfill({
		status: 200, contentType: 'application/gzip', body: readFileSync(join(web, '.forge/blender/roster.ssasset.gz')),
	}))
	await page.addInitScript(() => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {} })
	await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&devsize=48&devactors=1&devcluster=2&devtod=600${noforge ? '&noforge=1' : ''}`)
	await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
	// The new-world intake decodes the dev snapshot on a follow-up task, and a
	// frame must step after it for ctx.snapshot to appear. The manual pump is
	// fully synchronous, so warm up with yields between frames until the world
	// exists (bounded); waiting without stepping frames never satisfies.
	const value = await page.evaluate(async () => {
		const app = globalThis.steelseed; app.stop()
		for (let i = 0; i < 120 && app.ctx.snapshot === null; i++) {
			await new Promise(r => setTimeout(r, 16))
			app.renderOneFrame(i * 1000 / 60)
		}
		if (app.ctx.snapshot === null) throw new Error('dev world never materialized')
		if (!(app.ctx.snapshot.actors.count > 0)) throw new Error('dev world has no actors')
		const units = app.ctx.get('units'), cam = app.ctx.get('camera')
		for (const key of units.typeSlot.keys()) { units.typeSlot.set(key, '2tnk'); units.typeVehicle.set(key, true) }
		cam.height = 9; cam.heightGoal = 9
		const actors = app.ctx.snapshot.actors
		cam.target[0] = cam.targetGoal[0] = actors.posX[0] / 1024
		cam.target[2] = cam.targetGoal[2] = actors.posY[0] / 1024
		for (let i = 12; i < 60; i++) app.renderOneFrame(i * 1000 / 60)
		const bucket = units.slotBuckets.get('2tnk'), copy = document.createElement('canvas')
		copy.width = app.ctx.canvas.width; copy.height = app.ctx.canvas.height
		copy.getContext('2d').drawImage(app.ctx.canvas, 0, 0)
		return { stats: units.forgeStats, dropped: units.droppedSlots, surface: bucket.surfaceSet, active: bucket.count,
			lods: bucket.mesh.lods.map(l => l.indexCount), png: copy.toDataURL('image/png') }
	})
	assert.deepEqual(errors, [], 'no GPU/page errors')
	await page.close()
	return { ...value, warnings, png: Buffer.from(value.png.split(',')[1], 'base64') }
}
