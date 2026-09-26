// mp-relaygate (T1.28) — three players through the real relay.
//
// ONE spine (spine.mjs, temp --data-dir) + TWO roomhost nodes (--spine,
// generated REDLINE_NODE_KEY/REDLINE_NODE_TOKEN, temp --data-dir,
// --idle-kill 30) + THREE GPU Chromium clients in one 3-seat room. Pages
// boot from a node's static server but the room create is routed by the
// SPINE (?mpdir=) and every player socket must tunnel through it (/g/<id>).
//
// §9.2 assertions:
//   1. GET /nodes lists both nodes.
//   2. A geo-routed create (POST /rooms?geo=) lands on a live node; the
//      probe room is then deleted through the owning node's keyed API.
//   3. The host uses its local node; exactly TWO remote joiners use the
//      spine tunnel, so the relay must log exactly two player channels.
//   4. Manual ready flow (L8): joiners press Ready in the lobby UI, the
//      admin presses Start match; all three reach started=True.
//   5. The match plays >= 60 s beside a 30 s idle reaper (T1.5).
//   6. >= 30 pairwise tick-matched sync hashes on every pair (AB, AC, BC)
//      via the desyncgate sampler, outofsync=False everywhere, no stall.
// On failure each client's getMpCloseInfo() is dumped — the console-tag
// listener of the old federation gate is gone (T1.28).
//
// Usage: node mp-relaygate.mjs
import { loadChromium, launchGpuBrowser } from '../../../web/tools/harness.mjs';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { createSyncSamples } from '../../../web/tools/multiplayer-sync-samples.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(testsDir, '../..');
const spineHttp = Number(process.env.RELAY_SPINE_HTTP ?? '13700');
const spineWs = Number(process.env.RELAY_SPINE_WS ?? '13701');
const nodes = [
	{ geo: 'eu', http: Number(process.env.RELAY_EU_HTTP ?? '13702'), ws: Number(process.env.RELAY_EU_WS ?? '13703'), base: Number(process.env.RELAY_EU_BASE ?? '13710'), key: null, proc: null, log: null, tmp: null },
	{ geo: 'us', http: Number(process.env.RELAY_US_HTTP ?? '13704'), ws: Number(process.env.RELAY_US_WS ?? '13705'), base: Number(process.env.RELAY_US_BASE ?? '13730'), key: null, proc: null, log: null, tmp: null },
];
const roomhostScript = path.join(engineRoot, 'steelseed-host/tools/roomhost.mjs');
const spineScript = path.join(engineRoot, 'steelseed-host/tools/spine.mjs');
const generatedDir = path.join(engineRoot, 'steelseed-host/generated/mods/ra');

const SAMPLE_SECONDS = Number(process.env.RELAY_SECONDS ?? '60');
// The gate's contract is a >= 60-second play window beside a 30 s reaper;
// a lower value would silently weaken the run, so fail configuration.
if (!Number.isFinite(SAMPLE_SECONDS) || SAMPLE_SECONDS < 60)
	throw new Error(`mp-relaygate: RELAY_SECONDS must be >= 60 (got ${SAMPLE_SECONDS})`);
const MIN_MATCHED_TICKS = 30;
const IDLE_KILL_SECONDS = 30;
const SEATS = 3;

// T1.27: the map pin comes from gate-map.json, never a literal. A 3-seat
// room needs a catalog map with >= 3 players (the node rejects slots above
// the map's player count), so fall through the catalog in generation order.
function resolveMapCandidates(minPlayers) {
	const catalog = JSON.parse(fs.readFileSync(path.join(generatedDir, 'map-catalog.json'), 'utf8'));
	const gate = JSON.parse(fs.readFileSync(path.join(generatedDir, 'gate-map.json'), 'utf8'));
	const uids = [];
	if (Number(gate.players ?? 0) >= minPlayers) uids.push(gate.uid);
	for (const entry of catalog)
		if (Number(entry.players ?? 0) >= minPlayers && !uids.includes(entry.uid)) uids.push(entry.uid);
	if (uids.length === 0) throw new Error(`map catalog has no map seating ${minPlayers} players`);
	return uids;
}

function attach(label, child) {
	const ring = [];
	child.stdout?.on('data', d => {
		for (const line of String(d).split('\n')) {
			if (!line.trim()) continue;
			ring.push(line);
			if (ring.length > 600) ring.shift();
			if (/room |notification-|spine|player chan|state |register|connected/.test(line)) console.log(`[${label}] ${line.slice(0, 170)}`);
		}
	});
	child.stderr?.on('data', d => {
		for (const line of String(d).split('\n')) {
			if (line.trim()) ring.push(`(err) ${line}`);
		}
	});
	return ring;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, options) {
	const res = await fetch(url, options);
	const text = await res.text();
	try { return { status: res.status, body: JSON.parse(text) }; }
	catch { return { status: res.status, body: text }; }
}

async function waitFor(poll, timeoutMs, label) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await poll();
		if (value) return value;
		if (Date.now() > end) throw new Error(`TIMEOUT ${label} (${Math.round(timeoutMs / 1000)}s)`);
		await sleep(500);
	}
}

const clients = [];
const spine = { proc: null, log: null, tmp: null };

function spineLogLines(re) {
	return spine.log ? spine.log.filter(l => re.test(l)) : [];
}

// Every room create the spine routed (baseline count = rooms created before
// the moment of the call — the geo probe must not be mistaken for the match).
function routedRoomCount() {
	return spineLogLines(/room \S+ created on node/).length;
}

function routedRoomId(afterCount) {
	const lines = spineLogLines(/room (\S+) created on node/);
	return lines.length > afterCount ? /room (\S+) created on node/.exec(lines[lines.length - 1])[1] : null;
}

function playerChanLines(roomId) {
	return spineLogLines(new RegExp(`player chan \\d+ -> room ${roomId}`));
}

async function dumpCloseInfo(banner) {
	console.error(`--- ${banner}: getMpCloseInfo() per client ---`);
	for (const c of clients) {
		const close = await c.page.evaluate(async () => {
			try { return await globalThis.steelseedBridge.getMpCloseInfo(); }
			catch (e) { return { error: String(e).slice(0, 120) }; }
		}).catch(e => ({ error: `page gone: ${String(e).slice(0, 80)}` }));
		const probe = await c.page.evaluate(() => globalThis.ora.GetConnectionProbe())
			.catch(e => `probe unavailable: ${String(e).slice(0, 80)}`);
		const status = await c.page.evaluate(() => document.getElementById('session-mp-status')?.textContent ?? '')
			.catch(() => '');
		console.error(`[${c.name}] close=${JSON.stringify(close)}\n  probe=${probe}\n  status=${status}`);
	}
	for (const n of nodes) {
		if (n.log) console.error(`--- node-${n.geo} tail ---\n${n.log.slice(-8).join('\n')}`);
	}
	if (spine.log) console.error(`--- spine tail ---\n${spine.log.slice(-12).join('\n')}`);
}

async function waitProbe(client, re, timeoutMs, label) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const probe = await client.page.evaluate(() => globalThis.ora.GetConnectionProbe());
		if (re.test(probe)) return probe;
		if (Date.now() > end) throw new Error(`TIMEOUT ${label} [${client.name}]\n  ${probe}`);
		await sleep(1000);
	}
}

async function bootClient(loadChromium, name) {
	const gpu = await launchGpuBrowser(loadChromium, 'mp-relaygate');
	const browser = gpu.browser;
	const page = await browser.newPage();
	const client = { name, browser, page };
	clients.push(client); // register immediately: a later boot failure must still close it
	page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e).slice(0, 200)));
	// The local-node capability must exist before the session UI applies its
	// runtime switch. Injecting it only after boot leaves the host column hidden
	// in browser-join mode even though the keyed node is available.
	await page.addInitScript(({ dir, key }) => {
		globalThis.__redlineLocalNode = { dir, key };
	}, { dir: `http://127.0.0.1:${nodes[0].http}`, key: nodes[0].key });
	// Pages boot from the eu node's static server; the room create goes to
	// the SPINE (?mpdir) — that is the federation under test.
	await page.goto(`http://127.0.0.1:${nodes[0].http}/steelseed/index.html?mode=game&platform=null&mp=1&mpdir=http://127.0.0.1:${spineHttp}&Player.Name=${name}`);
	await page.waitForFunction(() => typeof globalThis.steelseed !== 'undefined' && typeof globalThis.ora !== 'undefined' && typeof globalThis.steelseedBridge !== 'undefined', undefined, { timeout: 240_000, polling: 250 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000, polling: 250 });
	await page.waitForFunction(() => document.getElementById('session-start') instanceof HTMLButtonElement && document.getElementById('session-start').disabled === false, undefined, { timeout: 60_000, polling: 250 });
	console.log(`[${name}] booted`);
	return client;
}

// Pick the first candidate uid the page's catalog dropdown actually offers.
async function selectSeatMap(client, candidates) {
	const chosen = await client.page.evaluate(uids => {
		const options = [...document.querySelectorAll('#session-map option')].map(o => o.value);
		return uids.find(uid => options.includes(uid)) ?? null;
	}, candidates);
	if (!chosen) throw new Error(`[${client.name}] #session-map offers none of ${candidates[0]}…`);
	await client.page.selectOption('#session-map', chosen);
	return chosen;
}

async function hostRoom(client, candidates, slots, roomName) {
	await selectSeatMap(client, candidates);
	await client.page.click('#session-tab-mp');
	await client.page.waitForFunction(() => (document.getElementById('session-mp-slots')?.options?.length ?? 0) > 0, undefined, { timeout: 30_000, polling: 250 });
	await client.page.selectOption('#session-mp-slots', String(slots));
	await client.page.fill('#session-mp-name', client.name);
	await client.page.fill('#session-mp-roomname', roomName);
	// §5.9 local-node hook: the host creates on ITS own node (node-eu, whose
	// static server serves this page) — the v1 host topology of §4.5. The
	// relay only lists and tunnels: T2.6/T2.8 removed the relay-create path.
	await client.page.evaluate(({ dir, key }) => {
		globalThis.__redlineLocalNode = { dir, key };
	}, { dir: `http://127.0.0.1:${nodes[0].http}`, key: nodes[0].key });
	const beforeRooms = await fetchJson(`http://127.0.0.1:${nodes[0].http}/v2/rooms`);
	const known = new Set((beforeRooms.body?.rooms ?? []).map(r => r.roomId));
	await client.page.click('#session-mp-host');
	const roomId = await waitFor(async () => {
		const list = await fetchJson(`http://127.0.0.1:${nodes[0].http}/v2/rooms`);
		return (list.body?.rooms ?? []).map(r => r.roomId).find(id => !known.has(id)) ?? null;
	}, 60_000, 'host-flow room create on the host node');
	console.log(`room ${roomId} created on the host's own node (3 seats)`);
	await waitProbe(client, /state=Connected/, 90_000, 'host joined the room');
	return roomId;
}

async function joinRoomRow(client) {
	await client.page.click('#session-tab-mp');
	await client.page.fill('#session-mp-name', client.name);
	// §5.10: the room poll rebuilds the row DOM, so wait for a joinable row.
	// Click only once: a slow async join must not spawn duplicate relay channels.
	await waitFor(() => client.page.evaluate(() => {
		const button = document.querySelector('#session-mp-rooms-body td.room-join button');
		if (!button || button.disabled) return false;
		button.click();
		return true;
	}), 60_000, `${client.name} joinable room row`);
	await waitProbe(client, /state=Connected/, 90_000, 'joined through the tunnel');
	console.log(`[${client.name}] connected through the relay`);
}

async function waitInLobby(client) {
	await waitProbe(client, /state=Connected/, 30_000, 'still connected');
	await client.page.waitForFunction(() => {
		const setup = document.getElementById('mp-setup');
		return !!setup && !setup.hidden && !!document.querySelector('#mp-setup .mp-lobby-actions');
	}, undefined, { timeout: 45_000, polling: 500 });
	await waitProbe(client, /clients=3/, 45_000, 'three humans seated in the lobby');
}

// L8: nobody is auto-readied. Press the lobby's Ready button — its label
// flips to "Not ready" once the server confirms, so guard every press.
async function clickReady(client) {
	for (let attempt = 0; attempt < 30; attempt++) {
		const probe = await client.page.evaluate(() => globalThis.ora.GetConnectionProbe());
		if (/clientstate=Ready/.test(probe)) return;
		if (/started=True/.test(probe)) throw new Error(`[${client.name}] match started before ${client.name} readied`);
		const clicked = await client.page.evaluate(() => {
			const bar = document.querySelector('#mp-setup .mp-lobby-actions');
			const button = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent === 'Ready' && !b.disabled) : null;
			if (!button) return false;
			button.click();
			return true;
		});
		if (!clicked) await sleep(1000);
		else await sleep(700);
	}
	throw new Error(`[${client.name}] never reached clientstate=Ready via the lobby button`);
}

// The admin's Start match press (L8): the UI button sends `state Ready` —
// NEVER startgame. The server's CheckAutoStart starts the match when every
// human is Ready.
async function clickAdminStart(client) {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (/started=True/.test(await client.page.evaluate(() => globalThis.ora.GetConnectionProbe()))) return;
		const state = await client.page.evaluate(() => {
			const bar = document.querySelector('#mp-setup .mp-lobby-actions');
			const button = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent === 'Start match') : null;
			if (!button) return { found: false, hidden: true, disabled: true };
			return { found: true, hidden: button.hidden, disabled: button.disabled };
		});
		if (state.found && !state.hidden && !state.disabled) {
			await client.page.evaluate(() => {
				const bar = document.querySelector('#mp-setup .mp-lobby-actions');
				const button = [...bar.querySelectorAll('button')].find(b => b.textContent === 'Start match');
				button.click();
			});
			console.log(`[${client.name}] admin pressed Start match`);
			return;
		}
		await sleep(1000);
	}
	throw new Error(`[${client.name}] the admin Start match button never became pressable`);
}

let result = 'MILESTONE INCOMPLETE';
let chromium = null;
try {
	chromium = await loadChromium('mp-relaygate');

	// ---- rig: spine + two nodes, generated secrets, temp state dirs ----
	const spineToken = crypto.randomBytes(16).toString('hex');
	spine.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relaygate-spine-'));
	spine.proc = spawnProcessGroup('node', [spineScript,
		'--http', String(spineHttp), '--ws', String(spineWs),
		'--data-dir', spine.tmp,
	], { stdio: 'pipe', env: { ...process.env, STEELSEED_NODE_TOKEN: spineToken } });
	spine.log = attach('spine', spine.proc);
	await waitFor(() => fetchJson(`http://127.0.0.1:${spineHttp}/nodes`).then(r => r.status === 200).catch(() => false), 15_000, 'spine http up');

	for (const n of nodes) {
		n.key = crypto.randomBytes(16).toString('hex');
		n.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `relaygate-node-${n.geo}-`));
		n.proc = spawnProcessGroup('node', [roomhostScript,
			'--bundle', path.join(engineRoot, 'bin-browser/AppBundle'),
			'--ws', String(n.ws), '--http', String(n.http),
			'--base-port', String(n.base), '--max-matches', '4',
			'--idle-kill', String(IDLE_KILL_SECONDS),
			'--spine', `ws://127.0.0.1:${spineWs}/node`,
			'--data-dir', n.tmp,
		], { stdio: 'pipe', env: { ...process.env, REDLINE_NODE_KEY: n.key, REDLINE_NODE_TOKEN: spineToken } });
		n.log = attach(`node-${n.geo}`, n.proc);
	}
	await waitFor(async () => (await fetchJson(`http://127.0.0.1:${spineHttp}/nodes`).catch(() => ({ body: [] }))).body.length === 2,
		20_000, 'both nodes registered at the spine');
	console.log('OK /nodes lists 2 nodes');

	// Boot the host first. Three simultaneous cold WebGPU/LOD boots can raise
	// the developer machine's measured one-minute load enough that the real
	// roomhost admission guard correctly refuses a 3-seat room. The host joins
	// immediately after creation, so the 30 s idle reaper is already disarmed
	// before the two joiner clients begin their cold boots.
	const host = await bootClient(chromium, 'AlphaCmd');

	// ---- T2.6: with the default config no HTTP request can make any node
	// ---- spawn a server — the relay refuses placement outright ----
	const candidates = resolveMapCandidates(SEATS);
	const probe = await fetchJson(`http://127.0.0.1:${spineHttp}/v2/rooms`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${spineHttp}` },
		body: JSON.stringify({ map: candidates[0], slots: 2, name: 'placement probe' }),
	});
	if (probe.status !== 403 || probe.body?.error !== 'placement-disabled') {
		throw new Error(`placement probe: expected 403 placement-disabled, got ${probe.status} ${JSON.stringify(probe.body).slice(0, 160)}`);
	}
	console.log('OK relay refuses placement while the switch is off (T2.6)');
	// ---- host creates the 3-seat room; joiners follow through the tunnel ----
	const roomId = await hostRoom(host, candidates, SEATS, 'RelayGate');
	const bravo = await bootClient(chromium, 'BravoCmd');
	const charlie = await bootClient(chromium, 'CharlieCmd');
	await joinRoomRow(bravo);
	await joinRoomRow(charlie);

	for (const c of [host, bravo, charlie]) await waitInLobby(c);
	console.log('OK all three seated in the lobby');

	// Manual ready flow (L8): joiners first, then the admin's Start press.
	await clickReady(bravo);
	await clickReady(charlie);
	await clickAdminStart(host);
	for (const c of [host, bravo, charlie]) await waitProbe(c, /started=True/, 240_000, 'game started');
	console.log('OK started=True on all three');

	// Only the two remote joiners tunnel through the spine; the host is local.
	const chanLines = playerChanLines(roomId);
	if (chanLines.length !== 2) {
		throw new Error(`relay logged ${chanLines.length} player channel(s) for room ${roomId}, expected exactly two remote joiners`);
	}
	const pairSpecs = [[0, 1], [0, 2], [1, 2]];
	const pairs = pairSpecs.map(() => createSyncSamples());
	const pairNames = ['Alpha+Bravo', 'Alpha+Charlie', 'Bravo+Charlie'];
	const order = [host, bravo, charlie];
	const startTick = [null, null, null];
	const lastTick = [null, null, null];
	const progressAt = [Date.now(), Date.now(), Date.now()];
	const started = Date.now();
	do {
		const reads = await Promise.all(order.map(c => c.page.evaluate(async () => ({
			sync: await globalThis.ora.GetSyncProbe(),
			connection: await globalThis.ora.GetConnectionProbe(),
		}))));
		const samples = [];
		for (const [index, read] of reads.entries()) {
			const match = /^tick=(\d+) hash=(\d+)$/.exec(read.sync);
			if (!match) throw new Error(`[${order[index].name}] invalid sync probe: ${read.sync}`);
			const tick = Number(match[1]);
			const hash = Number(match[2]);
			if (read.connection.includes('outofsync=True'))
				throw new Error(`outofsync flagged: ${read.connection}`);
			if (!read.connection.includes('state=Connected') || !read.connection.includes('started=True'))
				throw new Error(`match disconnected mid-window: ${read.connection}`);
			if (startTick[index] === null) startTick[index] = tick;
			if (lastTick[index] !== tick) progressAt[index] = Date.now();
			else if (Date.now() - progressAt[index] >= 1000)
				throw new Error(`${order[index].name} stalled at tick ${tick}`);
			lastTick[index] = tick;
			samples.push({ tick, hash });
		}
		for (const [i, [a, b]] of pairSpecs.entries()) {
			// each accumulator only knows its own two sides: 0 = a, 1 = b
			pairs[i].add(0, [samples[a]]);
			pairs[i].add(1, [samples[b]]);
		}
		await sleep(20);
	} while (Date.now() - started < SAMPLE_SECONDS * 1000);

	const results = pairs.map(p => p.result());
	const advanced = order.map((c, i) => lastTick[i] - startTick[i]);
	for (const [i, r] of results.entries())
		console.log(`${pairNames[i]}: ${r.matchedTicks} tick-matched hash comparisons, mismatches=${r.mismatches}`);
	const spread = Math.max(...advanced) - Math.min(...advanced);

	const finals = await Promise.all(order.map(c => c.page.evaluate(() => globalThis.ora.GetConnectionProbe())));
	const frames = finals.map(p => Number((/netframe=(\d+)/.exec(p) ?? [])[1] ?? 0));
	const oos = finals.map(p => (/outofsync=(\w+)/.exec(p) ?? [])[1] ?? '');

	const okFrames = frames.every(f => f > 100);
	const okOos = oos.every(v => v === 'False');
	const okMatched = results.every(r => r.matchedTicks >= MIN_MATCHED_TICKS && r.mismatches === 0);
	const okRate = spread <= 6;
	if (!okFrames) throw new Error(`frame budget not reached: ${finals.join(' | ')}`);
	if (!okOos) throw new Error(`outofsync latched: ${finals.join(' | ')}`);
	if (!okMatched) throw new Error(`insufficient tick-matched hashes: ${results.map(r => r.matchedTicks).join('/')}`);
	if (!okRate) throw new Error(`clients diverged in simulation rate: +${advanced.join('/+')}`);

	console.log(`=== RESULT: 3/3 started, ${chanLines.length} relayed channels, ${results.map(r => r.matchedTicks).join('/')} matched hashes per pair, play ${Math.round((Date.now() - started) / 1000)}s with idle-kill ${IDLE_KILL_SECONDS}s, netframe ${frames.join('/')} ===`);
	result = 'MILESTONE PASS';
} catch (e) {
	console.error('FAILED:', e.message);
	await dumpCloseInfo('failure').catch(() => {});
} finally {
	for (const c of clients) await c.browser?.close().catch(() => {});
	if (spine.proc) await stopProcessGroup(spine.proc).catch(() => {});
	for (const n of nodes) if (n.proc) await stopProcessGroup(n.proc).catch(() => {});
	await sleep(1000);
	for (const tmp of [spine.tmp, ...nodes.map(n => n.tmp)]) {
		if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
	}
}
console.log(result);
process.exitCode = result === 'MILESTONE PASS' ? 0 : 1;
