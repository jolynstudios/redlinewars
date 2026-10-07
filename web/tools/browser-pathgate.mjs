// Local browser/backend/window/focus proof against the single composed AppBundle.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { launchGpuBrowser } from './harness.mjs';

const base = process.env.BROWSER_GATE_URL ?? 'http://127.0.0.1:5199/steelseed/index.html';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('This gate only controls a loopback test server.');
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, process.env.BROWSER_GATE_OUTPUT ?? 'stage/phase1-browser-paths');
mkdirSync(out, { recursive: true });
const names = process.argv.slice(2);
const profiles = names.length ? names : ['chromium', 'chromium-webgl', 'webkit', 'firefox'];
const report = { simBuild: JSON.parse(readFileSync(resolve(root, 'engine/bin-browser/AppBundle/steelseed/build.json'))).simBuild, profiles: [] };
for (const name of profiles) {
	let browser;
	const entry = { name, status: 'failed', errors: [], windows: [] };
	report.profiles.push(entry);
	try {
		if (name.startsWith('chromium')) browser = (await launchGpuBrowser(chromium, 'browser-pathgate')).browser;
		else browser = await ({ firefox, webkit }[name]).launch({ headless: true });
		entry.version = browser.version();
		const page = await browser.newPage({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 1 });
		page.on('pageerror', error => entry.errors.push(error.message));
		await page.route('**/*', async route => {
			const url = new URL(route.request().url());
			if (url.pathname.endsWith('/net-config.json')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"schema":1,"browserMultiplayer":"off"}' });
			if (url.pathname === '/api/me') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null}' });
			if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { entry.errors.push('External request: ' + url.origin); return route.abort(); }
			return route.continue();
		});
		if (name === 'chromium-webgl') await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => undefined }));
		await page.goto(base + '?quality=low&gateQuery=preserved#browser-gate', { waitUntil: 'load' });
		const bootUrl = new URL(page.url());
		assert.equal(bootUrl.searchParams.get('mode'), 'game');
		assert.equal(bootUrl.searchParams.get('quality'), 'low');
		assert.equal(bootUrl.searchParams.get('gateQuery'), 'preserved');
		assert.equal(bootUrl.hash, '#browser-gate');
		await page.waitForFunction(() => globalThis.steelseedBridge && globalThis.steelseed && document.getElementById('boot')?.hidden && !document.getElementById('session-start')?.disabled, undefined, { timeout: 180000 });
		entry.backend = await page.evaluate(() => globalThis.steelseed.ctx.backend);
		if (name === 'chromium-webgl') assert.equal(entry.backend, 'webgl2');
		// Real keyboard activation, then the normal live engine world.
		await page.locator('#session-start').focus();
		await page.locator('#session-start').press('Enter');
		await page.waitForFunction(() => globalThis.steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui')?.hidden, undefined, { timeout: 120000 });
		for (const [width, height] of [[1512, 982], [1024, 768], [1920, 1080]]) {
			await page.setViewportSize({ width, height });
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			await page.locator('#hud-menu').click();
			await page.locator('#game-menu').waitFor({ state: 'visible' });
			await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#game-menu .console-dialog')).opacity) >= 0.99);
			await page.locator('#menu-resume').focus();
			assert.equal(await page.locator('#menu-resume').evaluate(el => document.activeElement === el), true);
			await page.screenshot({ path: resolve(out, `${name}-${width}.png`), animations: 'disabled' });
			await page.locator('#menu-resume').press('Enter');
			await page.locator('#game-menu').waitFor({ state: 'hidden' });
			entry.windows.push({ width, height, click: true, keyboard: true });
		}
		assert.deepEqual(entry.errors, []);
		entry.status = 'passed';
	} catch (error) { entry.error = error.message; }
	finally { await browser?.close(); writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
	console.log(`${name}: ${entry.status}${entry.error ? ' — ' + entry.error : ' (' + entry.backend + ')'}`);
}
process.exitCode = report.profiles.some(entry => entry.status !== 'passed') ? 1 : 0;
