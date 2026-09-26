// Two-window playable launcher: boots the REAL session-UI network flow and
// leaves both windows on screen for humans to play.
//   window A: "Host on this network" — waits for the second player
//   window B: "Join network game"    — as soon as it joins+readies, the
//                                      dedicated starts the match
// The script stays alive so the windows remain open. Ctrl+C stops everything.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser } from '../../../web/tools/harness.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..');
const dirPort = Number(process.env.PLAY_DIR ?? '13550');
const muxPort = Number(process.env.PLAY_WS ?? '13551');
const basePort = Number(process.env.PLAY_BASE ?? '13640');
// T1.27: the map uid is owned by the generated mod, never a literal — the
// authoritative value is steelseed-host/generated/mods/ra/gate-map.json
// (written by steelseed-host/tools/build-ra-mod.mjs; the uid is the SHA1 of
// the generated map payload, so it moves when generation moves). argv/env
// stay as an explicit override for one-off runs.
const GATE = JSON.parse(fs.readFileSync(path.join(repoRoot, 'steelseed-host/generated/mods/ra/gate-map.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(GATE.uid ?? '')) throw new Error('gate-map.json has no uid — run steelseed-host/tools/build-ra-mod.mjs');
const mapUid = process.argv[2] ?? process.env.PLAY_MAP ?? GATE.uid;

// T1.9: the node's API is keyed — the launcher generates the key, hands it
// to roomhost over env and gives the pages the §5.9 local-node hook
// (window.__redlineLocalNode {dir,key}) so the REAL host button creates the
// room on it (T3.1). The key never travels on argv or the URL.
const nodeKey = crypto.randomBytes(32).toString('hex');
const roomhost = spawn('node', [path.join(repoRoot, 'steelseed-host/tools/roomhost.mjs'),
	'--bundle', path.join(repoRoot, 'bin-browser/AppBundle'),
	'--ws', String(muxPort), '--http', String(dirPort),
	'--dedicated', path.join(repoRoot, 'launch-dedicated.sh'),
	'--base-port', String(basePort), '--max-matches', '2',
], { stdio: 'pipe', env: { ...process.env, REDLINE_NODE_KEY: nodeKey } });
roomhost.stdout?.on('data', d => { for (const l of String(d).split('\n')) if (/room |connected to|created/.test(l)) console.log('[roomhost]', l.slice(0, 140)); });
await new Promise(r => setTimeout(r, 1500));

async function boot(chromiumLaunch, name, query) {
	const browser = await chromiumLaunch({ headless: false, args: [
		'--use-angle=metal', '--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer',
		'--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-gpu-sandbox',
		'--window-size=1280,860',
	] });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e).slice(0, 200)));
	await page.goto(`http://127.0.0.1:${dirPort}/steelseed/index.html?mode=game&platform=null&mp=1&Player.Name=${name}${query}`);
	await page.waitForFunction(() => typeof globalThis.steelseed !== 'undefined' && typeof globalThis.ora !== 'undefined' && typeof globalThis.steelseedBridge !== 'undefined', undefined, { timeout: 240_000, polling: 250 });
	// §5.9 hook: this launcher runs the local node itself, so hand both
	// pages the directory the host button must POST to.
	await page.evaluate((dir, key) => { globalThis.__redlineLocalNode = { dir, key } }, `http://127.0.0.1:${dirPort}`, nodeKey);
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000, polling: 250 });
	await page.waitForFunction(() => document.getElementById('session-start') instanceof HTMLButtonElement && document.getElementById('session-start').disabled === false, undefined, { timeout: 60_000, polling: 250 });
	console.log(`[${name}] booted`);
	return page;
}

const A = await boot(chromium.launch.bind(chromium), 'Speler-A', '');
await page.waitForFunction(() => (document.getElementById('session-map')?.options?.length ?? 0) > 0, undefined, { timeout: 60_000, polling: 250 });
await A.click('#session-tab-mp');
await A.click('#session-mp-host');
console.log('[A] hosting — waiting for B…');

const B = await boot(chromium.launch.bind(chromium), 'Speler-B', '');
await B.selectOption('#session-map', mapUid);

// Read the room id from the spine room list (the UI host flow created it).
let roomId = null;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline && !roomId) {
	try {
		const rooms = await (await fetch(`http://127.0.0.1:${dirPort}/rooms`)).json();
		if (rooms.length > 0) roomId = rooms[rooms.length - 1].roomId;
	} catch { /* spine hiccup, retry */ }
	if (!roomId) await new Promise(r => setTimeout(r, 500));
}
console.log('room:', roomId);
// B joins through the room browser UI: Multiplayer tab, room row, Join.
await page.waitForFunction(() => (document.getElementById('session-map')?.options?.length ?? 0) > 0, undefined, { timeout: 60_000, polling: 250 });
await B.click('#session-tab-mp');
await B.waitForFunction(() => document.querySelectorAll('#session-mp-rooms-body button').length > 0, undefined, { timeout: 30_000, polling: 250 });
await B.click('#session-mp-rooms-body button');

async function waitProbe(page, re, timeoutMs, label) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const probe = await page.evaluate(() => globalThis.ora.GetConnectionProbe());
		if (re.test(probe)) { console.log(`OK ${label}`); return probe; }
		if (Date.now() > end) throw new Error(`TIMEOUT ${label}: ${probe}`);
		await new Promise(r => setTimeout(r, 1000));
	}
}
await waitProbe(A, /clientstate=(NotReady|Ready)/, 60_000, 'A claimed');
await B.evaluate(() => globalThis.ora.LobbyClaimPlayerSlot());
await waitProbe(B, /clientstate=(NotReady|Ready)/, 60_000, 'B claimed');
await waitProbe(A, /state=Connected/, 90_000, 'A connected');
await waitProbe(B, /state=Connected/, 90_000, 'B connected');
// Both humans are in the lobby; the dedicated auto-starts when both ready.
await A.evaluate(() => globalThis.ora.LobbySetReady());
await B.evaluate(() => globalThis.ora.LobbySetReady());
await waitProbe(A, /started=True/, 180_000, 'MATCH STARTED (A)');
await waitProbe(B, /started=True/, 180_000, 'MATCH STARTED (B)');
console.log(`
══════════════════════════════════════════════════
  De match draait. Twee vensters op je scherm:
    links/rechts = Speler-A en Speler-B (jij).
  Ctrl+C hier stopt alles netjes.
══════════════════════════════════════════════════`);
// Keep the process alive so the windows stay open while playing.
setInterval(() => {}, 60_000);
