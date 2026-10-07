// Full browser<->desktop networked game, standalone (outside the Playwright test
// runner, which drops the post-handshake connection in this environment). One
// browser client joins a live room through its ws endpoint, fills the opposing
// slot with a server-side bot, readies, starts, and
// must advance net frames in lockstep with the authoritative server without
// desync. Point it at a room's wsUrl (node /v2 API `room.wsUrl`; bare
// host:port dials are refused since T2.8).
// Usage: node mp-fullgame.mjs <wsUrl ws://127.0.0.1:<mux>/g/<roomId>> <mapUid>
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const wsUrl = process.argv[2] ?? '';
if (!/^wss?:\/\//.test(wsUrl)) throw new Error('usage: node mp-fullgame.mjs <wsUrl ws://127.0.0.1:<mux>/g/<roomId>> <mapUid>');
const relayPort = Number(new URL(wsUrl.replace(/^ws/, 'http')).port);
const mapUid = process.argv[3] ?? 'c6a14c146c2630a23783091d5d0d96341137f4d0';
const httpPort = 8355;
const TARGET_FRAMES = 200;

const field = (probe, key) => new RegExp(`${key}=([^ ]+)`).exec(probe)?.[1] ?? '';

const server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1000));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.error('[pageerror]', String(e)));

async function probe() { return page.evaluate(() => globalThis.ora.GetConnectionProbe()); }
async function pollMatch(re, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const p = await probe();
		if (re.test(p)) { console.log(`OK ${label}: ${p}`); return p; }
		await new Promise(r => setTimeout(r, 1000));
	}
	throw new Error(`TIMEOUT ${label}: ${await probe()}`);
}

try {
	await page.goto(`http://127.0.0.1:${httpPort}/index.html?mode=game&platform=webgl2&Host.DevContent=1&Launch.Map=${mapUid}&Player.Name=AlphaCmd`);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	console.log('booted');

	const endpoint = await page.evaluate(url => globalThis.ora.SetWsEndpoint(url), wsUrl);
	if (!endpoint.startsWith('endpoint ')) throw new Error(`SetWsEndpoint failed: ${endpoint}`);
	console.log('JoinMultiplayer:', await page.evaluate(p => globalThis.ora.JoinMultiplayer('127.0.0.1', p), relayPort));
	await pollMatch(/state=Connected/, 60_000, 'connected');

	await page.evaluate(() => globalThis.ora.LobbyClaimPlayerSlot());
	await pollMatch(/clientstate=(NotReady|Ready)/, 30_000, 'slotted');

	console.log('AddBots:', await page.evaluate(() => globalThis.ora.LobbyAddBots()));

	await page.evaluate(() => globalThis.ora.LobbySetReady());
	await pollMatch(/clientstate=Ready/, 30_000, 'ready');

	if (!/started=True/.test(await probe()))
		await page.evaluate(() => globalThis.ora.LobbyStartGame());

	await pollMatch(/started=True/, 120_000, 'game-started');
	const final = await pollMatch(new RegExp(`netframe=(${'\\d+'})`), 180_000, 'advancing');
	// Keep polling until the frame budget is reached.
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const p = await probe();
		const nf = Number(field(p, 'netframe'));
		if (field(p, 'outofsync') === 'True') throw new Error(`DESYNC at ${p}`);
		if (nf > TARGET_FRAMES) { console.log(`REACHED frame ${nf}: ${p}`); break; }
		await new Promise(r => setTimeout(r, 2000));
	}

	const end = await probe();
	console.log(`=== RESULT: netframe=${field(end, 'netframe')} outofsync=${field(end, 'outofsync')} ===`);
	console.log(field(end, 'outofsync') === 'False' && Number(field(end, 'netframe')) > TARGET_FRAMES
		? 'MILESTONE PASS' : 'MILESTONE INCOMPLETE');
} catch (e) {
	console.error('FAILED:', e.message);
} finally {
	await browser.close();
	server.kill();
}
