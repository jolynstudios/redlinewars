// PR 1 acceptance: the COMPOSED shipping bundle ( AppBundle + steelseed web
// presentation ) drives a network session through the ported host exports —
// single browser client joins a fresh room on the LOCAL NODE over its /v2 API
// and ws mux (the pre-T2.8 ws relay directory is deleted), claims a slot, fills the
// lobby with bots, readies, starts, and advances lockstep frames with
// outofsync=False.
//
// The page is the composed UI (…/steelseed/index.html), booted per the composed
// contract (steelseed + ora + steelseedBridge globals; never __s1_done).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser } from '../../../web/tools/harness.mjs';
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..');
const roomhostWs = Number(process.env.HOSTMP_RELAY ?? '13431');
const roomhostHttp = Number(process.env.HOSTMP_HTTP_API ?? '13432');
const httpPort = Number(process.env.HOSTMP_HTTP ?? '8364');
// T1.27: the map uid is owned by the generated mod; argv/env stay as an
// explicit override for one-off runs.
const GATE = JSON.parse(fs.readFileSync(path.join(repoRoot, 'steelseed-host/generated/mods/ra/gate-map.json'), 'utf8'));
const mapUid = process.argv[2] ?? process.env.HOSTMP_MAP ?? GATE.uid;
if (!/^[0-9a-f]{40}$/.test(mapUid)) throw new Error('no 40-hex map uid (run steelseed-host/tools/build-ra-mod.mjs)');
const TARGET_FRAMES = 200;

const field = (probe, key) => new RegExp(`${key}=([^ ]+)`).exec(probe)?.[1] ?? '';

function portOpen(port, host = '127.0.0.1') {
	return new Promise(resolve => {
		const s = net.connect({ host, port });
		s.on('connect', () => { s.destroy(); resolve(true); });
		s.on('error', () => resolve(false));
	});
}

function attach(label, child) {
	const ring = [];
	child.stdout?.on('data', d => {
		for (const line of String(d).split('\n')) {
			if (!line.trim()) continue;
			ring.push(line);
			if (ring.length > 400) ring.shift();
			if (/notification-|started|Accept|Rejected|Handshake|created|state |ws #|upgrade/.test(line))
				console.log(`[${label}] ${line.slice(0, 220)}`);
		}
	});
	child.stderr?.on('data', d => {
		for (const line of String(d).split('\n')) {
			if (line.trim()) ring.push(`(err) ${line}`);
		}
	});
	return ring;
}

// ---- node API client (the key never travels on argv) ----
const nodeKey = crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-fullgame-'));
function api(method, pathname, body = null) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: roomhostHttp, path: pathname, method, headers: { 'content-type': 'application/json', 'x-redline-node-key': nodeKey } }, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString();
				resolve({ status: res.statusCode, text, json: text.startsWith('{') ? JSON.parse(text) : null });
			});
		});
		req.on('error', reject);
		req.setTimeout(10_000, () => req.destroy(new Error('request timeout')));
		if (body !== null) req.write(JSON.stringify(body));
		req.end();
	});
}

const staticServer = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'pipe' });
await new Promise(r => setTimeout(r, 1000));

// The node owns the whole room lifecycle since T2.8: it spawns the dedicated
// server, exposes /v2/rooms and pumps the room's ws mux path.
const roomhost = spawn('node', [path.join(repoRoot, 'steelseed-host/tools/roomhost.mjs'),
	'--ws', String(roomhostWs), '--http', String(roomhostHttp),
	'--base-port', '13433', '--max-matches', '1', '--idle-kill', '60',
	'--data-dir', dataDir,
], {
	stdio: 'pipe',
	detached: true,
	env: { ...process.env, REDLINE_NODE_KEY: nodeKey },
});
const roomhostLog = attach('roomhost', roomhost);

const up = await (async () => {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try { if ((await api('GET', '/status.json')).status === 200) return true; } catch { /* not yet */ }
		await new Promise(r => setTimeout(r, 250));
	}
	return false;
})();
if (!up) {
	console.error(`--- roomhost tail ---\n${roomhostLog.slice(-30).join('\n')}`);
	throw new Error('roomhost API never came up');
}
console.log('roomhost-ready');

let result = 'MILESTONE INCOMPLETE';
// The composed web UI requires the WebGPU renderer path; plain chromium boots
// the WebGL2 fallback whose asset seam fails ("foliage source binding mismatch").
const launched = await launchGpuBrowser(chromium, 'mp-host-fullgame');
const browser = launched.browser;
const page = await browser.newPage();
page.on('pageerror', e => console.error('[pageerror]', String(e)));
page.on('console', m => { if (/\[mp\]|WebSocket|FATAL|handshake/i.test(m.text())) console.log(`[client] ${m.text().slice(0, 400)}`); });

try {
	// Create the room over /v2 (name required since T1.10), then wait for the
	// TCP-accept probe to flip it to 'reserved'.
	const created = await api('POST', '/v2/rooms', { map: mapUid, slots: 2, name: 'HostFull gate', solo: true });
	if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text.slice(0, 200)}`);
	const room = created.json.room;
	const wsUrl = room.wsUrl;
	console.log(`room ${room.roomId} created (ws ${wsUrl}, state ${room.state})`);
	const reservedDeadline = Date.now() + 20_000;
	for (;;) {
		const listing = await api('GET', '/v2/rooms');
		if (listing.json?.rooms?.some(r => r.roomId === room.roomId && r.state === 'reserved')) break;
		if (roomhost.exitCode !== null) throw new Error('roomhost exited early');
		if (Date.now() > reservedDeadline) throw new Error('room never reached reserved within 20 s');
		await new Promise(r => setTimeout(r, 500));
	}
	console.log('room-reserved');

	// Composed page: served from the AppBundle subdirectory compose.mjs created.
	await page.goto(`http://127.0.0.1:${httpPort}/steelseed/index.html?mode=game&platform=null&Player.Name=AlphaCmd`, { timeout: 60_000 });
	await page.waitForFunction(() => typeof globalThis.steelseed !== 'undefined' && typeof globalThis.ora !== 'undefined' && typeof globalThis.steelseedBridge !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	console.log('booted (composed)');

	const catalog = await page.evaluate(() => globalThis.steelseedBridge.getSkirmishCatalog());
	if (catalog.sessionTransports?.network?.supported !== true || catalog.sessionTransports.network.status !== 'available')
		throw new Error('network transport must be catalog-available after the PR 5 flip');
	console.log('catalog network=available confirmed');

	const probe = () => page.evaluate(() => globalThis.steelseedBridge.getConnectionProbe());
	async function pollMatch(re, timeoutMs, label) {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const p = await probe();
			if (re.test(p)) { console.log(`OK ${label}`); return p; }
			if (Date.now() > end) throw new Error(`TIMEOUT ${label}: ${p}`);
			await new Promise(r => setTimeout(r, 1000));
		}
	}

	// Join through the room's ws endpoint: SetWsEndpoint rebinds the
	// connection factory, JoinMultiplayer then dials the room path — never
	// the bare host:port.
	const endpoint = await page.evaluate(url => globalThis.ora.SetWsEndpoint(url), wsUrl);
	if (!endpoint.startsWith('endpoint ')) throw new Error(`SetWsEndpoint failed: ${endpoint}`);
	const muxPort = Number(new URL(wsUrl.replace(/^ws/, 'http')).port);
	console.log('join:', await page.evaluate(({ h, p }) => globalThis.steelseedBridge.joinMultiplayer(h, p), { h: '127.0.0.1', p: muxPort }));
	await pollMatch(/state=Connected/, 60_000, 'connected');
	await page.evaluate(() => globalThis.steelseedBridge.lobbyClaimPlayerSlot());
	await pollMatch(/clientstate=(NotReady|Ready)/, 30_000, 'slotted');
	console.log('bots:', await page.evaluate(() => globalThis.steelseedBridge.lobbyAddBots()));
	await page.evaluate(() => globalThis.steelseedBridge.lobbySetReady());
	await pollMatch(/clientstate=Ready/, 30_000, 'ready');
	if (!/started=True/.test(await probe()))
		await page.evaluate(() => globalThis.steelseedBridge.lobbyStartGame());
	await pollMatch(/started=True/, 120_000, 'game started');

	const deadline = Date.now() + 240_000;
	let end = await probe();
	for (;;) {
		end = await probe();
		if (field(end, 'outofsync') === 'True') throw new Error(`DESYNC: ${end}`);
		if (Number(field(end, 'netframe')) > TARGET_FRAMES) break;
		if (Date.now() > deadline) throw new Error(`frame budget timeout: ${end}`);
		await new Promise(r => setTimeout(r, 2000));
	}

	const frames = Number(field(end, 'netframe'));
	result = frames > TARGET_FRAMES && field(end, 'outofsync') === 'False' ? 'MILESTONE PASS' : 'MILESTONE INCOMPLETE';
	console.log(`=== RESULT: netframe=${frames} outofsync=${field(end, 'outofsync')} ===`);
} catch (e) {
	console.error('FAILED:', e.message);
	try { console.error('[client]', await page.evaluate(() => globalThis.steelseedBridge.getConnectionProbe())); } catch { /* gone */ }
	console.error(`--- roomhost tail ---\n${roomhostLog.slice(-30).join('\n')}`);
} finally {
	await browser.close().catch(() => {});
	staticServer.kill();
	if (roomhost.exitCode === null && roomhost.signalCode === null) {
		try { process.kill(-roomhost.pid, 'SIGTERM'); } catch { try { roomhost.kill('SIGTERM'); } catch { /* gone */ } }
		await new Promise(r => setTimeout(r, 3000));
		if (roomhost.exitCode === null && roomhost.signalCode === null) {
			try { process.kill(-roomhost.pid, 'SIGKILL'); } catch { try { roomhost.kill('SIGKILL'); } catch { /* gone */ } }
		}
	}
	fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(result);
process.exitCode = result === 'MILESTONE PASS' ? 0 : 1;
