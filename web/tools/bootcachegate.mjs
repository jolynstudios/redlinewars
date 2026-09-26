#!/usr/bin/env node
// STEELSEED — boot LOD cache gate.
//
// The QEM decimation of roster LOD1/LOD2 costs ~12 s of main-thread CPU at boot.
// The cache persists that output keyed by a digest over every input the
// generation reads. This gate proves the contract end to end:
//   boot 1 (cold store): hulls built, cache written, log names the build ms
//   boot 2 (warm store): hull build time collapses, and the uploaded geometry
//                        is IDENTICAL - vertex/triangle counts and uploaded
//                        bytes must match the cold boot exactly, because the
//                        cached LODs are the same pure function's output.
import assert from 'node:assert/strict'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'

let preview
let browser
try {
	preview = await startPrivateComposed(8497)
	;({ browser } = await launchGpuBrowser(await loadChromium('bootcache'), 'bootcache'))
	const context = await browser.newContext({ viewport: { width: 900, height: 650 }, deviceScaleFactor: 1 })
	const page = await context.newPage()
	const boot = async label => {
		const marks = []
		page.on('console', m => { if (m.text().includes('[units]')) marks.push(m.text()) })
		await page.goto(`${preview.baseUrl}&quality=low`, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined, { timeout: 180000, polling: 250 })
		// The units node logs once its init completes; wait for it explicitly.
		await page.waitForFunction(() => globalThis.__bootMarks?.length ? true : false, undefined, { timeout: 30000, polling: 100 }).catch(() => null)
		const stats = await page.evaluate(() => {
			const units = globalThis.steelseed.ctx.get('units')
			const render = globalThis.steelseed.ctx.get('render')
			return { uploadedCount: render.meshes?.uploadedCount ?? -1, forge: { ...units.forgeStats } }
		})
		const hullLine = marks.find(m => m.includes('archetype hulls')) ?? ''
		const ms = Number(/ in (\d+) ms/.exec(hullLine)?.[1] ?? 0)
		const hits = Number(/(\d+) LOD cache hits/.exec(hullLine)?.[1] ?? 0)
		console.log(`${label}: ${ms} ms, ${hits} cache hits, uploaded=${stats.uploadedCount}`)
		return { ms, hits, ...stats }
	}
	await page.evaluate(() => { globalThis.__bootMarks = [] }).catch(() => null)
	// Cold: wipe the store from inside the page origin, then boot fresh contexts.
	await page.goto(`${preview.baseUrl}&quality=low`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null)
	await page.evaluate(() => indexedDB.deleteDatabase('steelseed-lod-cache')).catch(() => null)
	const cold = await boot('cold')
	const warm = await boot('warm')
	assert.ok(cold.ms > 4000, `cold boot must do the real work (${cold.ms} ms)`)
	assert.ok(warm.hits > 100, `warm boot must hit the cache broadly (${warm.hits} hits)`)
	assert.ok(warm.ms < cold.ms * 0.5, `warm boot must halve the hull build at minimum (${warm.ms} vs ${cold.ms} ms)`)
	assert.equal(warm.uploadedCount, cold.uploadedCount, 'identical upload count')
	assert.equal(warm.forge.vertices, cold.forge.vertices, 'identical vertex totals')
	assert.equal(warm.forge.bytes, cold.forge.bytes, 'identical byte totals')
	console.log(`bootcachegate PASS — cold ${cold.ms} ms -> warm ${warm.ms} ms (${warm.hits} slots cached), geometry identical`)
	await context.close()
} finally {
	await browser?.close()
	await preview?.close?.()
}
