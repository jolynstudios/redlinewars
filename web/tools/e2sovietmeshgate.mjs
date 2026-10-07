#!/usr/bin/env node
// Live composed-runtime witness for the faction-specific E2 body and Ultra rain.
// Usage: node tools/e2sovietmeshgate.mjs --url=http://127.0.0.1:5198/steelseed/index.html
// Add --fixture for Vite preview (web/dist), where devmap can supply an actual rainy world.
import assert from 'node:assert/strict'
import { loadChromium, launchGpuBrowser } from './harness.mjs'

const urlArg = process.argv.find(arg => arg.startsWith('--url='))
const url = new URL(urlArg?.slice('--url='.length) ?? 'http://127.0.0.1:5198/steelseed/index.html')
const fixture = process.argv.includes('--fixture')
if (fixture) {
	url.searchParams.set('devmap', '1')
	url.searchParams.set('devsize', '48')
	url.searchParams.set('fog', '0')
	url.searchParams.set('devweather', '2')
	url.searchParams.set('devweatherintensity', '720')
	url.searchParams.set('daylight', 'day')
}
url.searchParams.set('quality', 'ultra')

const chromium = await loadChromium('e2sovietmeshgate')
const { browser } = await launchGpuBrowser(chromium, 'e2sovietmeshgate')
const context = await browser.newContext({ serviceWorkers: 'block' })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(String(error)))

try {
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
	await page.waitForFunction(() => globalThis.steelseed !== undefined ||
		(document.querySelector('#boot-fail')?.textContent && !document.querySelector('#boot-fail')?.hidden),
		undefined, { timeout: 150_000, polling: 100 })
	const bootFailure = await page.locator('#boot-fail').textContent().catch(() => '')
	assert.ok(await page.evaluate(() => globalThis.steelseed !== undefined), `boot failed: ${bootFailure}`)

	// AppBundle publishes the WASM bridge first, so its ?devmap=1 fallback is intentionally
	// bypassed there. A Vite-preview fixture exercises the real rainy snapshot path.
	const weatherObserved = !fixture || await page.waitForFunction(() => {
		const app = globalThis.steelseed
		return app.ctx.get('sky')?.rainIntensity > 0.02
	}, undefined, { timeout: 30_000, polling: 100 }).then(() => true, () => false)
	if (!weatherObserved) {
		const diagnostic = await page.evaluate(() => {
			const app = globalThis.steelseed
			return {
				url: location.href,
				quality: app?.config.q.name,
				weatherFx: app?.config.extras.weatherFx,
				world: app?.ctx.snapshot?.world ?? null,
				rainIntensity: app?.ctx.get('sky')?.rainIntensity,
				snowIntensity: app?.ctx.get('sky')?.snowIntensity,
				frameStats: app?.frameStats,
				status: document.querySelector('#session-mp-status')?.textContent,
			}
		})
		throw new Error(`test rain scene did not start: ${JSON.stringify(diagnostic).slice(0, 3000)}`)
	}
	const result = await page.evaluate(() => {
		const app = globalThis.steelseed
		const units = app.ctx.get('units')
		const e2 = units.slotBuckets.get('e2')
		const soviet = units.slotBuckets.get('e2.soviet')
		const civilian = units.slotBuckets.get('c1')
		const scenery = units.scenery
		const levels = mesh => mesh ? [mesh, ...(mesh.lods ?? [])].map(level => ({
			label: level.label, indices: level.indexCount, vertices: level.vertexCount,
		})) : []
		return {
			quality: app.config.q.name,
			weatherFx: app.config.extras.weatherFx,
			rainIntensity: app.ctx.get('sky').rainIntensity,
			rainParticles: scenery.pools.get('rain')?.count ?? null,
			e2Present: !!e2,
			sovietPresent: !!soviet,
			civilianPresent: !!civilian,
			sameBody: !!e2 && !!soviet && e2.mesh === soviet.mesh,
			civilianBody: !!civilian && !!soviet && civilian.mesh === soviet.mesh,
			alliedMaterial: e2?.surfaceSet ?? null,
			sovietMaterial: soviet?.surfaceSet ?? null,
			e2Levels: levels(e2?.mesh),
			sovietLevels: levels(soviet?.mesh),
			civilianLevels: levels(civilian?.mesh),
		}
	})
	console.log(JSON.stringify({ url: url.origin, result, errors }, null, 2))
	assert.equal(errors.length, 0, 'browser page errors')
	assert.equal(result.quality, 'ultra')
	assert.equal(result.e2Present && result.sovietPresent && result.civilianPresent, true)
	assert.equal(result.sameBody, true, 'Soviet E2 must share the Allied E2 mesh and LOD handles')
	assert.equal(result.civilianBody, false, 'Soviet E2 must never use civilian C1 geometry')
	assert.deepEqual(result.sovietLevels, result.e2Levels, 'Soviet E2 must keep every E2 LOD')
	assert.notEqual(result.sovietMaterial, result.alliedMaterial, 'factions need distinct material sets')
	assert.equal(result.weatherFx, true, 'Ultra must enable weather particles')
	if (fixture) {
		assert.ok(result.rainIntensity > 0.02, 'test scene must really contain rain')
		assert.ok(result.rainParticles > 0, 'rain must produce visible particles')
	}
	console.log('e2sovietmeshgate: PASS')
} finally {
	await browser.close()
}
