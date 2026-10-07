// PR 5 gate: the desync gate. roomhost (keyed node API, T1.9) + composed
// AppBundle + two GPU pages. The room is created over the node's keyed API
// and both clients dial its ws endpoint directly (the real-UI lobby path is
// exercised by mp-lan-ui and the lifecycle gate); then for >=60 seconds the
// gate polls both worlds concurrently into bounded tick-indexed histories,
// asserting:
//   1. OpenRA's own desync detector (outofsync) never flags on either client.
//   2. Sync hashes agree on every world tick both clients observed (the
//      accumulator throws on the first mismatch), with >= 30 distinct
//      matching ticks required — equality only when both sides sampled the
//      same tick, never on off-tick pairs.
//   3. Both clients advance the same number of ticks over the window
//      (equal simulation rate, |difference| <= 3).
//   4. Neither client's simulation stalls (every second advances the tick).
//   5. Neither page ever calls startSkirmish (no silent local fallback).
//
// Usage: node multiplayer-desyncgate.mjs   (from web/)
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs';
import { loadChromium, launchGpuBrowser } from './harness.mjs';
import { createSyncSamples } from './multiplayer-sync-samples.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(webDir, '../..');
const engineRoot = path.resolve(projectRoot, 'engine');
const dirPort = Number(process.env.DESYNC_DIR ?? '13486');
const muxPort = Number(process.env.DESYNC_WS ?? '13485');
const basePort = Number(process.env.DESYNC_BASE ?? '13490');
const bundleDir = path.join(engineRoot, 'bin-browser/AppBundle');
const roomhostScript = path.join(engineRoot, 'steelseed-host/tools/roomhost.mjs');
const dedicatedScript = path.join(engineRoot, 'launch-dedicated.sh');
// T1.27: the map uid is owned by the generated mod, never a literal — the
// authoritative value is steelseed-host/generated/mods/ra/gate-map.json
// (written by steelseed-host/tools/build-ra-mod.mjs; the uid is the SHA1 of
// the generated map payload, so it moves when generation moves). argv/env
// stay as an explicit override for one-off runs.
const GATE = JSON.parse(fs.readFileSync(path.join(engineRoot, 'steelseed-host/generated/mods/ra/gate-map.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(GATE.uid ?? '')) throw new Error('gate-map.json has no uid — run steelseed-host/tools/build-ra-mod.mjs');
const mapUid = process.argv[2] ?? process.env.DESYNC_MAP ?? GATE.uid;
const SAMPLE_SECONDS = Number(process.env.DESYNC_SECONDS ?? '60');
// The gate's contract is a >=60-second paired window; a lower value would
// silently weaken the run, so it fails configuration instead.
if (!Number.isFinite(SAMPLE_SECONDS) || SAMPLE_SECONDS < 60)
	throw new Error(`multiplayer-desyncgate: DESYNC_SECONDS must be >= 60 (got ${SAMPLE_SECONDS})`);
const MIN_MATCHED_TICKS = 30;

// ---- keyed node API client (the key never travels on argv) ----
const nodeKey = crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desyncgate-'));
const keyHeaders = { 'content-type': 'application/json', 'x-redline-node-key': nodeKey };

function api(method, pathname, body = null) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: dirPort, path: pathname, method, headers: keyHeaders }, res => {
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

const roomhost = spawnProcessGroup('node', [roomhostScript,
	'--bundle', bundleDir,
	'--ws', String(muxPort), '--http', String(dirPort),
	'--dedicated', dedicatedScript,
	'--base-port', String(basePort),
	'--max-matches', '2',
	'--data-dir', dataDir,
], { stdio: 'pipe', env: { ...process.env, REDLINE_NODE_KEY: nodeKey } });

function attach(label, child) {
	const ring = [];
	child.stdout?.on('data', d => {
		for (const line of String(d).split('\n')) {
			if (!line.trim()) continue;
			ring.push(line);
			if (ring.length > 400) ring.shift();
			if (/room |notification-|connected to/.test(line)) console.log(`[${label}] ${line.slice(0, 160)}`);
		}
	});
	child.stderr?.on('data', d => {
		for (const line of String(d).split('\n')) {
			if (line.trim()) ring.push(`(err) ${line}`);
		}
	});
	return ring;
}

const roomhostLog = attach('roomhost', roomhost);
// The API is up when /status.json answers; a dead roomhost fails the gate
// immediately with its log tail.
const up = await poll(() => roomStatus() !== null, 20_000, 250);
if (!up) {
	console.error(`--- roomhost tail ---\n${roomhostLog.slice(-30).join('\n')}`);
	throw new Error('roomhost API never came up');
}
console.log('roomhost-ready');

let result = 'MILESTONE INCOMPLETE';
const clients = [];
let chromium = null;
try {
	chromium = await loadChromium('multiplayer-desyncgate');
	async function boot(name, query) {
		const gpu = await launchGpuBrowser(chromium, 'multiplayer-desyncgate');
		const browser = gpu.browser;
		const page = await browser.newPage();
		// Register for cleanup immediately: a later boot failure must still
		// close this partially booted browser.
		const client = { name, browser, page };
		clients.push(client);
		page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e).slice(0, 200)));
		await page.goto(`http://127.0.0.1:${dirPort}/steelseed/index.html?mode=game&platform=null&mp=1&Player.Name=${name}${query}`);
		page.on('console', msg => {
			if (/mp|room|network|host/i.test(msg.text())) console.log(`[${name} console] ${msg.text().slice(0, 160)}`);
		});
		page.on('response', res => {
			if (res.url().includes('/rooms')) console.log(`[${name} net] ${res.request().method()} ${res.url()} -> ${res.status()}`);
		});
		await page.waitForFunction(() => typeof globalThis.steelseed !== 'undefined' && typeof globalThis.ora !== 'undefined' && typeof globalThis.steelseedBridge !== 'undefined', undefined, { timeout: 240_000, polling: 250 });
		await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000, polling: 250 });
		// Tripwire: a network session must never fall back to the local flow.
		await page.evaluate(() => {
			const bridge = globalThis.steelseedBridge;
			const original = bridge.startSkirmish.bind(bridge);
			bridge.startSkirmish = config => {
				globalThis.__startSkirmishCalled = (globalThis.__startSkirmishCalled ?? 0) + 1;
				return original(config);
			};
		});
		await page.waitForFunction(() => document.getElementById('session-start') instanceof HTMLButtonElement && document.getElementById('session-start').disabled === false, undefined, { timeout: 60_000, polling: 250 });
		console.log(`[${name}] booted`);
		return client;
	}

	const host = await boot('AlphaCmd', '');
	const joiner = await boot('BravoCmd', '');

	// T1.30-keyed: the room is created over the node API with the node key
	// header (name required since T1.10); the TCP-accept probe then flips it
	// to 'reserved'. The pages never touch the host flow — the paired sync
	// sampler, not the lobby UI, is this gate's subject.
	const created = await api('POST', '/v2/rooms', { map: mapUid, slots: 2, name: 'DesyncGate', solo: false });
	if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text.slice(0, 200)}`);
	const room = created.json.room;
	const wsUrl = room.wsUrl;
	console.log(`room ${room.roomId} created (ws ${wsUrl}, state ${room.state})`);
	const reserved = await poll(async () => {
		const st = await roomStatus();
		return Boolean(st?.rooms?.find(r => r.roomId === room.roomId)?.dedicatedAlive)
			&& st.log?.some(l => l.includes(`room ${room.roomId.slice(0, 6)}] state reserved`));
	}, 20_000);
	if (!reserved) throw new Error('room never reached reserved within 20 s');
	console.log('room-reserved');

	// Both clients dial the room's endpoint: SetWsEndpoint rebinds the
	// connection factory, JoinMultiplayer then joins through the room path —
	// never a bare host:port and never a local fallback.
	for (const c of clients) {
		const endpoint = await c.page.evaluate(url => globalThis.ora.SetWsEndpoint(url), wsUrl);
		if (!endpoint.startsWith('endpoint ')) throw new Error(`[${c.name}] SetWsEndpoint failed: ${endpoint}`);
	}
	for (const c of clients) {
		const joined = await c.page.evaluate(({ h, p }) => globalThis.ora.JoinMultiplayer(h, p), { h: '127.0.0.1', p: Number(new URL(wsUrl.replace(/^ws/, 'http')).port) });
		console.log(`[${c.name}] JoinMultiplayer -> ${joined}`);
	}

	async function waitBoth(re, timeoutMs, label) {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const probes = await Promise.all(clients.map(c => c.page.evaluate(() => globalThis.ora.GetConnectionProbe())));
			if (probes.every(p => re.test(p))) { console.log(`OK ${label}`); return probes; }
			if (Date.now() > end) throw new Error(`TIMEOUT ${label}\n  A: ${probes[0]}\n  B: ${probes[1]}`);
			await new Promise(r => setTimeout(r, 1000));
		}
	}
	await waitBoth(/state=Connected/, 60_000, 'BOTH CONNECTED');
	for (const c of clients) await c.page.evaluate(() => globalThis.ora.LobbyClaimPlayerSlot());
	await waitBoth(/clientstate=(NotReady|Ready)/, 30_000, 'both slotted');
	for (const c of clients) await c.page.evaluate(() => globalThis.ora.LobbySetReady());
	await waitBoth(/clientstate=Ready/, 30_000, 'both ready');
	if (!/started=True/.test((await Promise.all(clients.map(c => c.page.evaluate(() => globalThis.ora.GetConnectionProbe()))))[0]))
		await clients[0].page.evaluate(() => globalThis.ora.LobbyStartGame());
	await waitBoth(/started=True/, 180_000, 'game started on both');

	// Await each paired read: no overlapping timers or swallowed failures.
	// The accumulator retains unmatched ticks across polling rounds.
	const samples = createSyncSamples();
	const startTick = [null, null];
	const lastTick = [null, null];
	const progressAt = [Date.now(), Date.now()];
	const observed = [new Set(), new Set()];
	const started = Date.now();
	do {
		const probes = await Promise.all(clients.map(c => c.page.evaluate(async () => ({
			sync: await globalThis.ora.GetSyncProbe(),
			connection: await globalThis.ora.GetConnectionProbe(),
		}))));
		for (const [index, probe] of probes.entries()) {
			const match = /^tick=(\d+) hash=(\d+)$/.exec(probe.sync);
			if (!match) throw new Error(`[${clients[index].name}] invalid sync probe: ${probe.sync}`);
			const tick = Number(match[1]);
			const hash = Number(match[2]);
			if (probe.connection.includes('outofsync=True'))
				throw new Error(`outofsync flagged: ${probe.connection}`);
			if (!probe.connection.includes('state=Connected') || !probe.connection.includes('started=True'))
				throw new Error(`match disconnected: ${probe.connection}`);
			if (startTick[index] === null) startTick[index] = tick;
			if (lastTick[index] !== tick) progressAt[index] = Date.now();
			else if (Date.now() - progressAt[index] >= 1000)
				throw new Error(`client ${clients[index].name} stalled at tick ${tick}`);
			lastTick[index] = tick;
			observed[index].add(tick);
			samples.add(index, [{ tick, hash }]);
		}
		await new Promise(r => setTimeout(r, 20));
	} while (Date.now() - started < SAMPLE_SECONDS * 1000);
	console.log(`distinct sampled ticks: A=${observed[0].size}, B=${observed[1].size}`);

	const advancedA = lastTick[0] - startTick[0];
	const advancedB = lastTick[1] - startTick[1];
	const { matchedTicks, mismatches } = samples.result();
	console.log(`sampled ${Math.round((Date.now() - started) / 1000)}s: A advanced ${advancedA} ticks, B advanced ${advancedB} ticks, ${matchedTicks} tick-matched hash comparisons, mismatches=${mismatches}`);
	if (Math.abs(advancedA - advancedB) > 3)
		throw new Error(`clients diverged in simulation rate: A +${advancedA} vs B +${advancedB}`);
	if (matchedTicks < MIN_MATCHED_TICKS)
		throw new Error(`only ${matchedTicks} tick-matched comparisons (need >= ${MIN_MATCHED_TICKS}) — insufficient desync evidence`);

	const fallbacks = await Promise.all(clients.map(c => c.page.evaluate(() => globalThis.__startSkirmishCalled ?? 0)));
	if (fallbacks.some(v => v > 0)) throw new Error(`startSkirmish called ${fallbacks.join('/')} times — silent local fallback`);
	console.log('OK no startSkirmish fallback on either page');

	result = 'MILESTONE PASS';
	console.log(`=== RESULT: ${Math.round((Date.now() - started) / 1000)}s paired sampling, ${matchedTicks} tick-matched hashes, mismatches=${mismatches}, equal sim rate (+${advancedA}/+${advancedB}), outofsync=False on both, no local fallback ===`);
} catch (e) {
	console.error('FAILED:', e.message);
	// Every UI precondition failure writes a human-readable status line; dump
	// both pages' status so the blocker is visible without another rerun.
	for (const c of clients) {
		const status = await c.page?.$eval('#session-mp-status', el => el.textContent)
			.catch(() => '(page gone)');
		console.error(`[${c.name} #session-mp-status] ${status}`);
	}
	console.error(`--- roomhost tail ---\n${roomhostLog.slice(-15).join('\n')}`);
} finally {
	for (const c of clients) await c.browser?.close().catch(() => {});
	await stopProcessGroup(roomhost);
	fs.rmSync(dataDir, { recursive: true, force: true });
	await new Promise(r => setTimeout(r, 1000));
}
console.log(result);
process.exitCode = result === 'MILESTONE PASS' ? 0 : 1;
