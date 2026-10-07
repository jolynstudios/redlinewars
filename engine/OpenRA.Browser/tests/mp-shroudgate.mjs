// PR 2 gate (per-client shroud isolation): two browser clients play one
// fog-on lockstep match against a fresh room on the LOCAL NODE, and EACH
// client's snapshot pipeline must only ever expose actors the OWN player can
// see. With fog on and separated spawns, the enemy count in each client's
// GetVisibilityProbe must be zero at match start while own > 0.
//
// The probe reads the same player resolution the snapshot emitter uses
// (world.RenderPlayer ?? world.LocalPlayer, Program.Bridge.cs), so a leak here
// is a snapshot-visibility leak.
//
// T1.30: the legacy relay is retired here — the gate spawns roomhost,
// creates the room over its API with the node key header, waits for the room
// to reach 'reserved', and both clients join via SetWsEndpoint(room.wsUrl).
//
// Usage: node mp-shroudgate.mjs
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
const roomhostWs = Number(process.env.SHROUD_ROOMHOST_WS ?? '13441');
const roomhostHttp = Number(process.env.SHROUD_ROOMHOST_HTTP ?? '13442');
const basePort = Number(process.env.SHROUD_BASE ?? '13440');
const httpPort = Number(process.env.SHROUD_HTTP ?? '8366');
// T1.27: the map uid is owned by the generated mod, never a literal here —
// the authoritative value is steelseed-host/generated/mods/ra/gate-map.json
// (written by steelseed-host/tools/build-ra-mod.mjs; the uid is the SHA1 of
// the generated map payload, so it moves when generation moves). argv/env
// stay as an explicit override for one-off runs.
const GATE = JSON.parse(fs.readFileSync(path.join(repoRoot, 'steelseed-host/generated/mods/ra/gate-map.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(GATE.uid ?? '')) throw new Error('gate-map.json has no uid — run steelseed-host/tools/build-ra-mod.mjs');
const mapUid = process.argv[2] ?? process.env.SHROUD_MAP ?? GATE.uid;
const FRAMES = 60; // short match; shroud truth is decided at spawn, then we keep the sim alive

const field = (probe, key) => new RegExp(`${key}=([^ ]+)`).exec(probe)?.[1] ?? '';

// ---- node API client (the key never travels on argv) ----
const nodeKey = crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudgate-'));
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
			if (/notification-|Reject|Handshake fail|created|state |upgrade|ws #|connected to/.test(line)) console.log(`[${label}] ${line.slice(0, 220)}`);
		}
	});
	child.stderr?.on('data', d => {
		for (const line of String(d).split('\n')) {
			if (line.trim()) ring.push(`(err) ${line}`);
			if (ring.length > 400) ring.shift();
		}
	});
	return ring;
}

const staticServer = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'pipe' });
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

const up = await poll(() => roomStatus() !== null, 20_000, 250);
if (!up) {
	console.error(`--- roomhost tail ---\n${roomhostLog.slice(-30).join('\n')}`);
	throw new Error('roomhost API never came up');
}
console.log('roomhost-ready');

const launchArgs = [
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding'
];

async function boot(name) {
	const browser = await chromium.launch({ args: launchArgs });
	const page = await browser.newPage();
	page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e)));
	// The root host defaults to rules inspection; multiplayer requires the
	// long-running game mode that publishes and pumps the `ora` bridge.
	await page.goto(`http://127.0.0.1:${httpPort}/index.html?mode=game&platform=null&Player.Name=${encodeURIComponent(name)}`);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	console.log(`[${name}] booted`);
	return { name, browser, page };
}

let result = 'MILESTONE INCOMPLETE';
const clients = [];
try {
	clients.push(await boot('AlphaCmd'));
	clients.push(await boot('BravoCmd'));

	// T1.30: create the room over the node API (name required since T1.10),
	// then wait for the TCP-accept probe to flip it to 'reserved'.
	const created = await api('POST', '/v2/rooms', { map: mapUid, slots: 2, name: 'Shroud gate', solo: false });
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
		const end = Date.now() + timeoutMs;
		for (;;) {
			const ps = await probes();
			if (ps.every(p => re.test(p))) { console.log(`OK ${label}`); return ps; }
			if (Date.now() > end) throw new Error(`TIMEOUT ${label}\n  A: ${ps[0]}\n  B: ${ps[1]}`);
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
	for (const c of clients)
		console.log(`[${c.name}] join:`, await c.page.evaluate(({ h, p }) => globalThis.ora.JoinMultiplayer(h, p), { h: '127.0.0.1', p: Number(new URL(wsUrl.replace(/^ws/, 'http')).port) }));
	await allMatch(/state=Connected/, 60_000, 'BOTH CONNECTED');
	for (const c of clients)
		await c.page.evaluate(() => globalThis.ora.LobbyClaimPlayerSlot());
	await allMatch(/clientstate=(NotReady|Ready)/, 30_000, 'both slotted');
	// Force a two-player match: with every other slot closed the two humans get
	// distinct spawn points, so fog MUST hide the opponent at match start. (With
	// open slots filled, bots spawn on top of players and the assertion would be
	// meaningless.)
	console.log('close slots:', await clients[0].page.evaluate(() => globalThis.ora.LobbyCloseEmptySlots()));
	for (const c of clients)
		await c.page.evaluate(() => globalThis.ora.LobbySetReady());
	await allMatch(/clientstate=Ready/, 30_000, 'both ready');
	if (!/started=True/.test((await probes())[0]))
		await clients[0].page.evaluate(() => globalThis.ora.LobbyStartGame());
	await allMatch(/started=True/, 120_000, 'game started on both');

	// Sample each client's visibility while the match runs. The first window is
	// the shroud assertion (spawn separation + fog means zero enemy actors);
	// afterwards we only require the sim to stay alive and desync-free.
	const samples = [];
	const sampleEnd = Date.now() + FRAMES * 2000;
	let resultProbes = await probes();
	while (Date.now() < sampleEnd) {
		resultProbes = await probes();
		if (resultProbes.some(p => field(p, 'outofsync') === 'True'))
			throw new Error(`DESYNC: ${resultProbes[0]} | ${resultProbes[1]}`);
		samples.push(await Promise.all(clients.map(c => c.page.evaluate(() => globalThis.ora.GetVisibilityProbe()))));
		if (samples.length >= 3) break;
		await new Promise(r => setTimeout(r, 2000));
	}
	for (let i = 0; i < samples.length; i++) console.log(`[sample ${i}] A: ${samples[i][0]}\n[sample ${i}] B: ${samples[i][1]}`);

	// Shroud assertions on the FIRST sample (match start).
	for (const [idx, s] of samples[0].entries()) {
		const viewer = field(s, 'viewer');
		if (viewer === 'null' || viewer === '')
			throw new Error(`client ${idx} has no resolved snapshot player (renderPlayer/localPlayer null): ${s}`);
		if (Number(field(s, 'own')) <= 0)
			throw new Error(`client ${idx} cannot see its own units: ${s}`);
		if (Number(field(s, 'enemy')) > 0)
			throw new Error(`SHROUD LEAK on client ${idx}: enemy actors visible at spawn: ${s}`);

		// The counter and the detail list are filled by the same loop: if they
		// ever disagree, one of them is lying (this is exactly how a stale probe
		// counted zero enemies while listing them).
		const listPart = /enemyList=\[(.*)\]/.exec(s)?.[1] ?? '';
		const listed = listPart.length === 0 ? 0 : listPart.split('; ').length;
		if (Number(field(s, 'enemy')) !== listed)
			throw new Error(`PROBE INCONSISTENT on client ${idx}: enemy=${field(s, 'enemy')} but enemyList has ${listed}: ${s}`);
	}

	const frames = resultProbes.map(p => Number(field(p, 'netframe')));
	const oos = resultProbes.map(p => field(p, 'outofsync'));
	result = oos.every(v => v === 'False') && frames.every(f => f > FRAMES / 2) ? 'MILESTONE PASS' : 'MILESTONE INCOMPLETE';
	console.log(`=== RESULT: A frame=${frames[0]} B frame=${frames[1]} outofsync=${oos.join('/')} shroud=isolated ===`);
} catch (e) {
	console.error('FAILED:', e.message);
	try {
		for (const c of clients)
			console.error(`[${c.name}] vis:`, await c.page.evaluate(() => globalThis.ora.GetVisibilityProbe()));
	} catch { /* clients gone */ }
	console.error(`--- roomhost tail ---\n${roomhostLog.slice(-20).join('\n')}`);
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
