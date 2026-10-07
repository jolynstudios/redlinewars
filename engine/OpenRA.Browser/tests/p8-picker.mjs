// P8 picker fallback: boots with NO Host.ContentSource and no served content, so
// the host falls back to the user file-picker; Playwright supplies the genuine
// quickinstall zip through the real <input type=file>, which the page turns into
// a blob: URL that C# HttpClient reads (the flagged runtime risk). Verifies the
// blob path installs the content and the game boots.
// Usage: node p8-picker.mjs <quickinstall-zip-path>
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const appBundle = path.resolve(testsDir, '../../bin-browser/AppBundle');
const zipPath = process.argv[2];
const port = 8358;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
let devContentRequests = 0;

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		// Serve no content and no devcontent, forcing the picker fallback.
		if (url.pathname.startsWith('/devcontent/')) {
			devContentRequests++;
			res.writeHead(404);
			res.end();
			return;
		}
		if (url.pathname.startsWith('/content/')) { res.writeHead(404); res.end(); return; }
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

// Boot through the Lua-free browser shellmap, then prove the installed archive
// is playable by starting a fresh skirmish. Supplying Launch.Map here would
// pre-load a Regular world and make the later StartSkirmish call invalid.
const bootUrl = `http://127.0.0.1:${port}/index.html?mode=game&platform=webgl2`;
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on('pageerror', e => console.error('[pageerror]', String(e)));
page.on('console', m => { if (/\[host\]|content|install|FATAL|error|verif|extract|blob/i.test(m.text())) console.log(`[c] ${m.text().slice(0, 160)}`); });

let installed = false;
let skirmishStarted = false;
page.on('console', m => { if (/installed \d+ files/.test(m.text())) installed = true; });

try {
	console.log('=== BOOT with no content source (expect picker prompt) ===');
	await page.goto(bootUrl);

	// The host installs content before the runtime exports ora, so wait for the
	// picker's file input to appear, then supply the archive through it.
	await page.waitForSelector('#content-installer-file', { state: 'attached', timeout: 120_000 });
	console.log('picker prompt appeared; supplying archive through the real file input (blob path)');
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 240_000 }),
		page.setInputFiles('#content-installer-file', zipPath)
	]);

	// The content-required bootstrap exposes `ora` before installation so it can
	// call InstallContentArchive. Do not mistake that pre-install export for a
	// successful game boot: wait for the installer-triggered reload and its
	// completed runMain result.
	await page.waitForFunction(() => globalThis.__s1_done?.exitCode === 0, undefined, { timeout: 240_000 });
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	console.log('ora ready after picker install');
	console.log('world before StartSkirmish:', await page.evaluate(() => globalThis.ora.GetWorldProbe()));
	console.log('available maps before StartSkirmish:', await page.evaluate(() => {
		const maps = globalThis.ora.ListMaps();
		return maps === 'not initialized' ? maps : maps.split('\n').length;
	}));
	if (devContentRequests !== 0)
		throw new Error(`production picker boot made ${devContentRequests} forbidden /devcontent request(s)`);

	// Marshal the rejection explicitly: a rejected JSExport Task can otherwise be
	// printed by the outer catch while this standalone driver still exits zero.
	const started = await page.evaluate(async () => {
		try {
			return { ok: true, value: await globalThis.ora.StartSkirmish('', 1) };
		} catch (error) {
			return { ok: false, error: String(error?.stack ?? error) };
		}
	});
	if (!started.ok)
		throw new Error(`StartSkirmish rejected: ${started.error}`);
	if (/^failed:/i.test(String(started.value)))
		throw new Error(`StartSkirmish returned ${started.value}`);

	console.log('StartSkirmish:', started.value);
	await page.waitForFunction(() => {
		try {
			const probe = globalThis.ora.GetWorldProbe();
			return /type=Regular/.test(probe) && /\(bot\)/.test(probe);
		} catch {
			return false;
		}
	}, undefined, { timeout: 180_000 });
	console.log('skirmish world:', await page.evaluate(() => globalThis.ora.GetWorldProbe()));
	skirmishStarted = true;

	console.log(installed ? 'P8 PICKER PASS' : 'P8 PICKER PASS (playable world verified; install log not captured)');
} catch (e) {
	console.error('P8 PICKER FAILED:', e.message);
	process.exitCode = 1;
} finally {
	await browser.close();
	server.close();
}

if (!skirmishStarted)
	process.exitCode = 1;
