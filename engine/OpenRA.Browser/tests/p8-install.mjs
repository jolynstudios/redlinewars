// P8 acceptance: freeware auto-installer. Serves the AppBundle plus a genuine
// quickinstall zip at a SAME-ORIGIN /content/ URL (so the browser fetch needs no
// CORS), boots a fresh context with Host.ContentSource pointing at it, and
// verifies the installer fetches → verifies → extracts → installs the content,
// the game boots into a playable skirmish, and a reload restores from IndexedDB
// with zero refetch. Deliberately does NOT serve /devcontent/, so the install
// must come from ContentSource.
// Usage: node p8-install.mjs <quickinstall-zip-path>
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const appBundle = path.resolve(testsDir, '../../bin-browser/AppBundle');
const zipPath = process.argv[2];
const port = 8357;

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.zip': 'application/zip' };

let contentRequests = 0;
const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		if (url.pathname === '/content/ra-quickinstall.zip') {
			contentRequests++;
			const data = await fs.readFile(zipPath);
			res.writeHead(200, { 'content-type': 'application/zip', 'content-length': data.length });
			res.end(data);
			return;
		}
		if (url.pathname.startsWith('/devcontent/')) { res.writeHead(404); res.end('no devcontent in P8 test'); return; }
		let p = decodeURIComponent(url.pathname);
		if (p.endsWith('/')) p += 'index.html';
		const file = path.normalize(path.join(appBundle, p));
		if (!file.startsWith(appBundle)) { res.writeHead(403); res.end(); return; }
		const data = await fs.readFile(file);
		res.writeHead(200, { 'content-type': mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store' });
		res.end(data);
	} catch (e) { res.writeHead(e?.code === 'ENOENT' ? 404 : 500); res.end(String(e?.code ?? e)); }
});
await new Promise(r => server.listen(port, r));

const contentUrl = `http://127.0.0.1:${port}/content/ra-quickinstall.zip`;
// Launch a real (non-Lua) map so boot doesn't hit the lua51-less shellmap.
const bootUrl = `http://127.0.0.1:${port}/index.html?mode=game&platform=webgl2&Launch.Map=Siberian-Pass.oramap&Host.ContentSource=${encodeURIComponent(contentUrl)}`;

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', e => console.error('[pageerror]', String(e)));
page.on('console', m => { if (/\[host\]|install|content|FATAL|error|extract|verif/i.test(m.text())) console.log(`[c] ${m.text().slice(0, 160)}`); });
let passed = false;

async function bootAndWait(p) {
	await p.goto(bootUrl);
	await p.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await p.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
}

try {
	console.log('=== FIRST BOOT (auto-install from ContentSource) ===');
	await bootAndWait(page);
	console.log(`ora ready; content fetches so far: ${contentRequests}`);
	// Prove the content actually installed by starting a skirmish (needs the .mix data).
	const started = await page.evaluate(() => globalThis.ora.StartSkirmish('', 1));
	if (/^failed:/i.test(String(started)))
		throw new Error(`StartSkirmish returned ${started}`);
	console.log('StartSkirmish:', started);
	await page.waitForFunction(() => { try { return /type=Regular/.test(globalThis.ora.GetWorldProbe()); } catch { return false; } }, undefined, { timeout: 180_000 });
	console.log('skirmish world:', await page.evaluate(() => globalThis.ora.GetWorldProbe()));
	await page.evaluate(() => globalThis.ora.FlushSupportDir());
	await page.waitForTimeout(1500);
	const afterFirst = contentRequests;

	console.log('=== RELOAD (expect zero refetch — IndexedDB restore) ===');
	await bootAndWait(page);
	const afterReload = contentRequests - afterFirst;
	console.log(`content fetches on reload: ${afterReload}`);
	console.log(`ora ready after reload: ${await page.evaluate(() => globalThis.ora.IsRunning())}`);

	console.log(`=== RESULT: firstInstall=${afterFirst} reloadRefetch=${afterReload} ===`);
	if (afterFirst < 1 || afterReload !== 0)
		throw new Error(`installer request counts were first=${afterFirst}, reload=${afterReload}`);

	passed = true;
	console.log('P8 AUTO-INSTALL PASS');
} catch (e) {
	console.error('P8 FAILED:', e.message);
	process.exitCode = 1;
} finally {
	await browser.close();
	server.close();
}

if (!passed)
	process.exitCode = 1;
