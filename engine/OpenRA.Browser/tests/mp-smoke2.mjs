// Two-client MP diagnostic: boots two browser clients in SEPARATE Chromium
// instances (separate processes, each foreground) so neither is rAF-throttled
// or starved by sharing one renderer. Joins both against a running relay+server
// and logs each client's connection probe until both connect.
// Usage: node mp-smoke2.mjs <wsUrl ws://127.0.0.1:<mux>/g/<roomId>> <mapUid>
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const wsUrl = process.argv[2] ?? '';
if (!/^wss?:\/\//.test(wsUrl)) throw new Error('usage: node mp-smoke2.mjs <wsUrl ws://127.0.0.1:<mux>/g/<roomId>> <mapUid>');
const relayPort = Number(new URL(wsUrl.replace(/^ws/, 'http')).port);
const mapUid = process.argv[3] ?? 'c6a14c146c2630a23783091d5d0d96341137f4d0';
const httpPort = 8353;

const launchArgs = [
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding'
];

const server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1000));

async function boot(name) {
	const browser = await chromium.launch({ args: launchArgs });
	const page = await browser.newPage();
	page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e)));
	page.on('console', m => { if (/WebSocket|FATAL|Connecting|handshake/i.test(m.text())) console.log(`[${name}] ${m.text().slice(0, 140)}`); });
	await page.goto(`http://127.0.0.1:${httpPort}/index.html?mode=game&platform=webgl2&Host.DevContent=1&Launch.Map=${mapUid}&Player.Name=${name}`);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	console.log(`[${name}] booted`);
	return { browser, page };
}

const a = await boot('AlphaCmd');
const b = await boot('BravoCmd');

for (const [name, c] of [['AlphaCmd', a], ['BravoCmd', b]]) {
	const endpoint = await c.page.evaluate(url => globalThis.ora.SetWsEndpoint(url), wsUrl);
	if (!endpoint.startsWith('endpoint ')) throw new Error(`[${name}] SetWsEndpoint failed: ${endpoint}`);
	const joined = await c.page.evaluate(p => globalThis.ora.JoinMultiplayer('127.0.0.1', p), relayPort);
	console.log(`[${name}] JoinMultiplayer -> ${joined}`);
}

for (let i = 0; i < 30; i++) {
	await new Promise(r => setTimeout(r, 1000));
	const pa = await a.page.evaluate(() => globalThis.ora.GetConnectionProbe());
	const pb = await b.page.evaluate(() => globalThis.ora.GetConnectionProbe());
	console.log(`+${i + 1}s A: ${pa}`);
	console.log(`+${i + 1}s B: ${pb}`);
	if (/state=Connected/.test(pa) && /state=Connected/.test(pb)) {
		console.log('BOTH CONNECTED');
		break;
	}
}

console.log('=== 2-CLIENT SMOKE DONE ===');
await a.browser.close();
await b.browser.close();
server.kill();
