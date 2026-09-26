// PR 0 gate (issues/net-1.md): TWO browser clients must join one fresh room
// on the LOCAL NODE, lobby up, start, and advance lockstep net frames with
// outofsync=False on BOTH clients. This is the standalone replacement for the
// parked Playwright two-browser spec: the Playwright runner drops the
// post-handshake connection in this environment, so the committed gate drives
// two separate Chromium instances directly.
//
// Composition (all loopback): server.mjs (static wasm host) + roomhost.mjs
// (the node: hardened key/API + ws mux + per-room dedicated server).
// T1.30: the legacy relay is retired here — the gate spawns roomhost,
// creates the room over its API with the node key header, waits for the room
// to reach 'reserved', and both clients join via SetWsEndpoint(room.wsUrl).
// roomhost is spawned HERE so the root cause of any second-client stall is
// reproducible in one command.
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..'); // the engine tree
const roomhostWs = Number(process.env.TWOC_ROOMHOST_WS ?? '13421');
const roomhostHttp = Number(process.env.TWOC_ROOMHOST_HTTP ?? '13422');
const basePort = Number(process.env.TWOC_BASE ?? '13420');
const httpPort = Number(process.env.TWOC_HTTP ?? '8363');
// T1.27: the map uid is owned by the generated mod, never a literal here —
// the authoritative value is steelseed-host/generated/mods/ra/gate-map.json
// (written by steelseed-host/tools/build-ra-mod.mjs; the uid is the SHA1 of
// the generated map payload, so it moves when generation moves). argv/env
// stay as an explicit override for one-off runs.
const GATE = JSON.parse(fs.readFileSync(path.join(repoRoot, 'steelseed-host/generated/mods/ra/gate-map.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(GATE.uid ?? '')) throw new Error('gate-map.json has no uid — run steelseed-host/tools/build-ra-mod.mjs');
const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'steelseed-host/generated/mods/ra/map-catalog.json'), 'utf8'));
const mutableLobbyMap = catalog.find(entry => Number(entry.players) >= 4);
const mapUid = process.argv[2] ?? process.env.TWOC_MAP ?? mutableLobbyMap?.uid ?? GATE.uid;
const mapEntry = catalog.find(entry => entry.uid === mapUid);
if (Number(mapEntry?.players) < 4) throw new Error('two-client mutability gate requires a generated map with at least four slots');

const field = (probe, key) => new RegExp(`${key}=([^ ]+)`).exec(probe)?.[1] ?? '';
const TARGET_FRAMES = 200;

// ---- node API client (the key never travels on argv) ----
const nodeKey = crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twoclient-'));
const keyHeaders = { 'content-type': 'application/json', 'x-redline-node-key': nodeKey };

function api(method, pathname, body = null) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: roomhostHttp, path: pathname, method, headers: keyHeaders }, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString();
				resolve({ status: res.statusCode, text, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
			});
		});
		req.on('error', reject);
		req.setTimeout(10_000, () => req.destroy(new Error('request timeout')));
		if (body !== null) req.write(JSON.stringify(body));
		req.end();
	});
}

async function roomStatus() {
	try {
		const res = await api('GET', '/status.json');
		return res.status === 200 ? res.json : null;
	} catch { return null; }
}

async function poll(fn, timeoutMs, everyMs = 500) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > deadline) return null;
		await new Promise(r => setTimeout(r, everyMs));
	}
}

function attach(label, child) {
	const ring = [];
	child.stdout?.on('data', d => {
		for (const line of String(d).split('\n')) {
			if (!line.trim()) continue;
			ring.push(line);
			if (ring.length > 400) ring.shift();
			if (/Initial (mod|map):|has joined|GameStarted|started|Accept|Rejected|Handshake|created|state |upgrade|ws #|connected to/.test(line))
				console.log(`[${label}] ${line.slice(0, 220)}`);
		}
	});
	child.stderr?.on('data', d => {
		for (const line of String(d).split('\n')) {
			if (!line.trim()) continue;
			ring.push(`(err) ${line}`);
			if (ring.length > 400) ring.shift();
		}
	});
	return ring;
}

const staticServer = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'pipe' });
attach('static', staticServer);
await new Promise(r => setTimeout(r, 1000));

const roomhost = spawn('node', [path.join(repoRoot, 'steelseed-host/tools/roomhost.mjs'),
	'--ws', String(roomhostWs), '--http', String(roomhostHttp),
	'--base-port', String(basePort), '--max-matches', '1', '--idle-kill', '60',
	'--data-dir', dataDir,
], {
	stdio: 'pipe',
	detached: true,
	env: { ...process.env, REDLINE_NODE_KEY: nodeKey },
});
const roomhostLog = attach('roomhost', roomhost);

// The API is up when /status.json answers; a dead roomhost fails the gate
// immediately with its log tail.
const up = await poll(() => roomStatus() !== null, 20_000, 250);
if (!up) {
	console.error(`--- roomhost tail ---\n${roomhostLog.slice(-30).join('\n')}`);
	throw new Error('roomhost API never came up');
}
console.log('roomhost-ready');

function portOpen(port, host = '127.0.0.1') {
	return new Promise(resolve => {
		const s = net.connect({ host, port });
		s.on('connect', () => { s.destroy(); resolve(true); });
		s.on('error', () => resolve(false));
	});
}

const launchArgs = [
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding'
];

async function boot(name) {
	const browser = await chromium.launch({ args: launchArgs });
	const page = await browser.newPage();
	page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e)));
	page.on('console', m => { if (/\[mp\]|WebSocket|FATAL|handshake/i.test(m.text())) console.log(`[${name}] ${m.text().slice(0, 4000)}`); });
	// No Launch.Map: a preselected map makes the host auto-start a local
	// skirmish; the network game's map is chosen by the dedicated server.
	// main.js defaults to the rules host when mode is omitted. This gate needs
	// the long-running game host that publishes `ora` and pumps multiplayer.
	await page.goto(`http://127.0.0.1:${httpPort}/index.html?mode=game&platform=null&debug=on&Player.Name=${encodeURIComponent(name)}`);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	console.log(`[${name}] booted`);
	return { name, browser, page };
}

const clients = [];
let result = 'MILESTONE INCOMPLETE';
try {
	clients.push(await boot('AlphaCmd'));
	clients.push(await boot('BravoCmd'));

	// T1.30: create the room over the node API (name required since T1.10),
	// then wait for the TCP-accept probe to flip it to 'reserved'.
	// Four slots leave two openings after both humans join.  This deliberately
	// exercises that ordinary (non-Ranked) lobbies retain their mutable bot
	// controls while the Ranked-only server authority rejects the same command.
	const created = await api('POST', '/v2/rooms', { map: mapUid, slots: 4, name: 'TwoClient gate', solo: false });
	if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text.slice(0, 200)}`);
	const room = created.json.room;
	const wsUrl = room.wsUrl;
	console.log(`room ${room.roomId} created (ws ${wsUrl}, state ${room.state})`);

	const reserved = await poll(async () => {
		const st = await roomStatus();
		const entry = st?.rooms?.find(r => r.roomId === room.roomId);
		return entry?.dedicatedAlive && st.log?.some(l => l.includes(`room ${room.roomId.slice(0, 6)}] state reserved`));
	}, 20_000);
	if (!reserved) throw new Error('room never reached reserved within 20 s');
	console.log('room-reserved');

	const probes = () => Promise.all(clients.map(c => c.page.evaluate(() => globalThis.ora.GetConnectionProbe())));

	async function allMatch(re, timeoutMs, label) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const ps = await probes();
			if (ps.every(p => re.test(p))) { console.log(`OK ${label}`); return ps; }
			if (Date.now() > deadline) throw new Error(`TIMEOUT ${label}\n  A: ${ps[0]}\n  B: ${ps[1]}`);
			await new Promise(r => setTimeout(r, 1000));
		}
	}

	// Join through the room's ws endpoint: SetWsEndpoint rebinds the
	// connection factory, JoinMultiplayer then dials the room path — never
	// the bare host:port.
	for (const c of clients) {
		const endpoint = await c.page.evaluate(url => globalThis.ora.SetWsEndpoint(url), wsUrl);
		console.log(`[${c.name}] SetWsEndpoint -> ${endpoint}`);
		if (!endpoint.startsWith('endpoint ')) throw new Error(`SetWsEndpoint failed: ${endpoint}`);
	}
	for (const c of clients) {
		const joined = await c.page.evaluate(({ h, p }) => globalThis.ora.JoinMultiplayer(h, p), { h: '127.0.0.1', p: Number(new URL(wsUrl.replace(/^ws/, 'http')).port) });
		console.log(`[${c.name}] JoinMultiplayer -> ${joined}`);
	}
	await allMatch(/state=Connected/, 60_000, 'BOTH CONNECTED');

	for (const c of clients) {
		await c.page.evaluate(() => globalThis.ora.LobbyClaimPlayerSlot());
	}
	await allMatch(/clientstate=(NotReady|Ready)/, 30_000, 'both slotted');

	const addBots = await clients[0].page.evaluate(() => globalThis.ora.LobbyAddBots());
	console.log('AddBots:', addBots);
	if (!/^added [1-9]\d* bots$/.test(addBots))
		throw new Error(`ordinary lobby bot mutation regressed: ${addBots}`);

	for (const c of clients) {
		await c.page.evaluate(() => globalThis.ora.LobbySetReady());
	}
	await allMatch(/clientstate=Ready/, 30_000, 'both ready');

	if (!/started=True/.test((await probes())[0]))
		await clients[0].page.evaluate(() => globalThis.ora.LobbyStartGame());

	await allMatch(/started=True/, 120_000, 'game started on both');

	// Player HUD check: both pages must list both human players with a
	// connection-quality dot (the bottom-left panel driven by
	// GetLobbyPlayersProbe). Bots may appear as extra rows.
	const panelA = await clients[0].page.evaluate(() => globalThis.steelseedBridge.getLobbyPlayersProbe());
	const panelB = await clients[1].page.evaluate(() => globalThis.steelseedBridge.getLobbyPlayersProbe());
	if (!panelA.includes('AlphaCmd') || !panelA.includes('BravoCmd') || !panelB.includes('AlphaCmd') || !panelB.includes('BravoCmd'))
		throw new Error(`player HUD incomplete: A=${panelA} B=${panelB}`);
	console.log(`OK player HUD lists both humans on both clients`);

	let last = await allMatch(new RegExp(`netframe=(\\d+)`), 180_000, 'frames advancing');
	const deadline = Date.now() + 240_000;
	for (;;) {
		last = await probes();
		const frames = last.map(p => Number(field(p, 'netframe')));
		const oos = last.map(p => field(p, 'outofsync'));
		if (oos.some(v => v === 'True')) throw new Error(`DESYNC: A:${last[0]} B:${last[1]}`);
		if (frames.every(f => f > TARGET_FRAMES)) { console.log(`REACHED frames ${frames.join('/')}`); break; }
		if (Date.now() > deadline) throw new Error(`frame budget timeout: A:${last[0]} B:${last[1]}`);
		await new Promise(r => setTimeout(r, 2000));
	}

	const frames = last.map(p => Number(field(p, 'netframe')));
	const oos = last.map(p => field(p, 'outofsync'));
	result = frames.every(f => f > TARGET_FRAMES) && oos.every(v => v === 'False') ? 'MILESTONE PASS' : 'MILESTONE INCOMPLETE';
	console.log(`=== RESULT: A netframe=${frames[0]} B netframe=${frames[1]} outofsync=${oos.join('/')} ===`);
} catch (e) {
	console.error('FAILED:', e.message);
	try {
		for (const c of clients) console.error(`[${c.name}] ${(await c.page.evaluate(() => globalThis.ora.GetConnectionProbe()))}`);
	} catch { /* clients may be gone */ }
	console.error(`--- roomhost tail ---\n${roomhostLog.slice(-30).join('\n')}`);
} finally {
	for (const c of clients) await c.browser.close().catch(() => {});
	staticServer.kill();
	// roomhost's SIGTERM handler kills every room's dedicated tree; escalate
	// to SIGKILL if it does not exit promptly.
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
