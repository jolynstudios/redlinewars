// Manual MP validation: one browser client joins a live room through its ws
// endpoint and confirms the WebSocket transport reaches the dedicated server
// (handshake + lobby sync). Point it at a room's wsUrl (the node /v2 API
// answers `room.wsUrl`; bare host:port dials are refused since T2.8).
// Usage: node mp-smoke.mjs <wsUrl ws://127.0.0.1:<mux>/g/<roomId>> <mapUid>
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const wsUrl = process.argv[2] ?? '';
if (!/^wss?:\/\//.test(wsUrl)) throw new Error('usage: node mp-smoke.mjs <wsUrl ws://127.0.0.1:<mux>/g/<roomId>> <mapUid>');
const relayPort = Number(new URL(wsUrl.replace(/^ws/, 'http')).port);
const mapUid = process.argv[3] ?? 'c6a14c146c2630a23783091d5d0d96341137f4d0';
const httpPort = 8352;

const server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1000));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.error('[pageerror]', String(e)));
page.on('console', m => { if (/\[host\]|error|FATAL|WebSocket/i.test(m.text())) console.log(`[console] ${m.text().slice(0, 160)}`); });

await page.goto(`http://127.0.0.1:${httpPort}/index.html?mode=game&platform=webgl2&Host.DevContent=1&Launch.Map=${mapUid}`);
await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
console.log('booted; local world:', await page.evaluate(() => globalThis.ora.GetWorldProbe()));

const endpoint = await page.evaluate(url => globalThis.ora.SetWsEndpoint(url), wsUrl);
if (!endpoint.startsWith('endpoint ')) throw new Error(`SetWsEndpoint failed: ${endpoint}`);
const joined = await page.evaluate(p => globalThis.ora.JoinMultiplayer('127.0.0.1', p), relayPort);
console.log('JoinMultiplayer:', joined);

for (let i = 0; i < 30; i++) {
	await new Promise(r => setTimeout(r, 1000));
	const probe = await page.evaluate(() => globalThis.ora.GetConnectionProbe());
	console.log(`+${i + 1}s`, probe);
	if (/state=Connected/.test(probe) && /clientstate=(NotReady|Ready)/.test(probe))
		break;
}

console.log('=== SMOKE DONE ===');
await browser.close();
server.kill();
