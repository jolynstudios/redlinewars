// mp-communitygate (W-E2E) — player-created community rooms, end to end.
//
// ONE spine (placement donated, browserMultiplayer full, the local-gate
// create-limit relaxation) + node A (standing, --accept-placed,
// --max-matches 4, --admin-idle-seconds 150, TWO standing rooms-file entries)
// + node B (donate, regression). Pages boot from node A's patched bundle
// (net-config relay = the local spine) with NO local-node hook, so every
// create goes through the SPINE like a real browser player.
//
// Matrix:
//   1. A browser maker opens a 3-seat room as a spectator (checkbox): the
//      spine places it on the standing node (community), the room lists with
//      hostKind 'community', the maker is admin WITHOUT a seat (slot:none)
//      and Start stays disabled until two players are seated.
//   2. Two players join through the spine tunnel, Ready, the spectating
//      admin readies and starts; all three started=True, the two players
//      tick-match ≥ 20 s of hashes, the spectator stays connected.
//   3. Admin-leave mid-match: the maker leaves; the engine reassigns admin
//      (notification-new-admin), the players and the match survive.
//   4. Idle demotion: a maker waiting ALONE is never demoted; with a second
//      member waiting and the maker silent past --admin-idle-seconds the
//      node drops the maker's tunnel and the player takes admin; room lives.
//   5. Share link: ?room=<id> on a fresh navigation joins the room seated.
//   6. Community ceiling + fallback: slots 5 skips the standing node for a
//      donate node even while the standing node has capacity; with the
//      standing node at --max-matches a new room falls back to donate.
//
// Usage: node mp-communitygate.mjs
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
const toolsDir = path.join(engineRoot, 'steelseed-host/tools');
const roomhostScript = path.join(toolsDir, 'roomhost.mjs');
const spineScript = path.join(toolsDir, 'spine.mjs');
const generatedDir = path.join(engineRoot, 'steelseed-host/generated/mods/ra');

const spineHttp = Number(process.env.COMMUNITY_SPINE_HTTP ?? '13760');
const spineWs = Number(process.env.COMMUNITY_SPINE_WS ?? '13761');
const nodeA = { http: Number(process.env.COMMUNITY_A_HTTP ?? '13762'), ws: Number(process.env.COMMUNITY_A_WS ?? '13763'), base: Number(process.env.COMMUNITY_A_BASE ?? '13770'), key: null, proc: null, log: null, tmp: null };
const nodeB = { http: Number(process.env.COMMUNITY_B_HTTP ?? '13764'), ws: Number(process.env.COMMUNITY_B_WS ?? '13765'), base: Number(process.env.COMMUNITY_B_BASE ?? '13790'), key: null, proc: null, log: null, tmp: null };

// The idle window must exceed every legit silent wait in the earlier phases
// (the maker sits in the lobby while the two players boot and join, ~1 min);
// phase 4 then scales its alone/demote waits past it.
const ADMIN_IDLE_SECONDS = 150;  // node A's --admin-idle-seconds
const ALONE_WAIT_MS = 165_000;   // > the timer, with the maker alone: no demotion
const DEMOTE_WAIT_MS = 300_000;  // silent maker + one waiter: demotion must land
const SAMPLE_SECONDS = 45;       // sync window for the two seated players
const MIN_MATCHED_TICKS = 20;
const PAGE_ORIGIN = `http://127.0.0.1:${nodeA.http}`;
const PAGE_BASE = `${PAGE_ORIGIN}/steelseed/index.html`;

// The map pin comes from gate-map.json, never a literal (T1.27).
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
			// Unbounded on purpose: matchers poll this history for minutes
			// (idle demotion waits 300 s) while the dedicated servers stay
			// chatty — a capped ring shifted the demotion line out before the
			// poll saw it. A gate run is short-lived; a few MB is fine.
			if (/room |notification-|spine|player chan|state |register|connected|admin|create|capacity|standing/.test(line))
				console.log(`[${label}] ${line.slice(0, 170)}`);
		}
	});
	child.stderr?.on('data', d => {
		for (const line of String(d).split('\n')) if (line.trim()) ring.push(`(err) ${line}`);
	});
	return ring;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, options) {
	const res = await fetch(url, options);
	const text = await res.text();
	try { return { status: res.status, headers: res.headers, body: JSON.parse(text) }; }
	catch { return { status: res.status, headers: res.headers, body: text }; }
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
const spine = { proc: null, log: null, tmp: null, configDir: null };

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
	const gpu = await launchGpuBrowser(loadChromium, 'mp-communitygate');
	const client = { name, browser: gpu.browser, page: await gpu.browser.newPage() };
	clients.push(client);
	client.page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e).slice(0, 200)));
	// Console ring: the engine and the mp-socket shim live in the sim WORKER,
	// so their [mp] lines (websocket open/error/close, join failures) surface
	// here, not in any page DOM. Keep a bounded ring for the failure dump and
	// echo the transport-relevant lines live.
	client.consoleRing = [];
	client.page.on('console', msg => {
		const text = msg.text();
		client.consoleRing.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
		if (client.consoleRing.length > 600) client.consoleRing.shift();
		if (/\[mp\]|websocket|join|connection|endpoint|error/i.test(text)) console.log(`[${name} console] ${text.slice(0, 150)}`);
	});
	// NO __redlineLocalNode here on purpose: a plain browser in full mode must
	// reach for the spine (net-config relay) exactly like a real player.
	await client.page.goto(`${PAGE_BASE}?mode=game&platform=null&mp=1&Player.Name=${name}`);
	// WebSocket tap: every ws this page opens, with its close code. A join that
	// dies server-side (4404 wrong host key, 4403 origin, 1011) is otherwise
	// invisible — the HUD just retries and the room-list poll overwrites the
	// status line. (The wasm boots after this, so the wrapper is in place
	// before any join.)
	await client.page.evaluate(() => {
		globalThis.__wsTap = [];
		const OrigWebSocket = window.WebSocket;
		window.WebSocket = class extends OrigWebSocket {
			constructor(url, protocols) {
				super(url, protocols);
				const rec = { url: String(url).slice(0, 90), code: null, reason: '', at: new Date().toISOString() };
				globalThis.__wsTap.push(rec);
				this.addEventListener('close', e => { rec.code = e.code; rec.reason = String(e.reason).slice(0, 40); });
			}
		};
	});
	await client.page.waitForFunction(() => typeof globalThis.steelseed !== 'undefined' && typeof globalThis.ora !== 'undefined' && typeof globalThis.steelseedBridge !== 'undefined', undefined, { timeout: 240_000, polling: 250 });
	// Status history: the HUD prints a verdict (join refused, relay error…)
	// into #session-mp-status, but the room-list poll overwrites it within
	// seconds — a dump after the fact sees only "N network rooms found."
	// Record every change; the failure dump replays the last few.
	await client.page.evaluate(() => {
		globalThis.__statusHistory = [];
		const record = text => globalThis.__statusHistory.push({ at: new Date().toISOString(), text: String(text).slice(0, 110) });
		const el = document.getElementById('session-mp-status');
		if (el) {
			record(el.textContent);
			new MutationObserver(() => record(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
		}
	});
	await client.page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000, polling: 250 });
	await client.page.waitForFunction(() => document.getElementById('session-start') instanceof HTMLButtonElement && document.getElementById('session-start').disabled === false, undefined, { timeout: 60_000, polling: 250 });
	console.log(`[${name}] booted`);
	return client;
}

async function selectSeatMap(client, candidates) {
	// A client that just left a room sits on the multiplayer view; the map
	// select lives on the skirmish panel. Re-selecting the tab is a no-op when
	// it is already active.
	await client.page.click('#session-tab-skirmish').catch(() => {});
	const chosen = await client.page.evaluate(uids => {
		const options = [...document.querySelectorAll('#session-map option')].map(o => o.value);
		return uids.find(uid => options.includes(uid)) ?? null;
	}, candidates);
	if (!chosen) throw new Error(`[${client.name}] #session-map offers none of ${candidates[0]}…`);
	await client.page.selectOption('#session-map', chosen);
	return chosen;
}

// One /events frame: the whole-network snapshot (nodes with freeMatches,
// rooms, latencyMs, healthy). /network is HTML and /status.json does not
// exist — the SSE stream is the only JSON snapshot the spine serves.
async function oneSnapshot() {
	const res = await fetch(`http://127.0.0.1:${spineHttp}/events`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) throw new Error('events closed before a frame');
			const line = decoder.decode(value).split('\n').find(l => l.startsWith('data: '));
			if (line) return JSON.parse(line.slice(6));
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}

// Diagnostic (S23 hunt): the shipped client caches ONE /v2/config verdict per
// session, so the capacity the page saw at boot decides the host button. Log
// every capacity transition from rig-up on, and whenever capacity reads zero
// the per-node snapshot plus this machine's own load — the three real causes
// (rtt ≥ 80 exclusion, unhealthy sampler, no free matches) are distinguishable
// only with both.
function watchCapacity() {
	let last = null;
	const timer = setInterval(async () => {
		try {
			const cfg = await fetchJson(`http://127.0.0.1:${spineHttp}/v2/config`);
			const cap = JSON.stringify(cfg.body.capacity ?? {});
			if (cap === last) return;
			last = cap;
			console.log(`[capacity] /v2/config → ${cap}`);
			if ((cfg.body.capacity?.donatedFree ?? 1) === 0 && (cfg.body.capacity?.ownerFree ?? 1) === 0) {
				const snap = await oneSnapshot().catch(() => null);
				const nodes = snap?.nodes ?? [];
				const load = os.loadavg().map(l => l.toFixed(2)).join(' ');
				const memFree = Math.round(os.freemem() / 1024 / 1024);
				console.log(`[capacity] zero at ${new Date().toISOString()} load=[${load}] memFree=${memFree}MB: ${nodes.map(n => `${n.id}(free=${n.freeMatches},rooms=${n.rooms},lat=${n.latencyMs},healthy=${n.healthy},degraded=${n.degraded})`).join(' ')}`);
			}
		} catch { /* spine restarting */ }
	}, 2000);
	timer.unref();
	return () => clearInterval(timer);
}

// One dump at the exact moment the gate presses Host: the button verdict the
// page cached, plus what the spine says right now.
async function dumpHostMoment(client) {
	const ui = await client.page.evaluate(() => {
		const btn = document.getElementById('session-mp-host');
		const status = document.getElementById('session-mp-status');
		const spectate = document.getElementById('session-mp-spectate');
		return { disabled: btn?.disabled, title: btn?.title ?? '', status: status?.textContent ?? '', spectate: spectate?.checked ?? null };
	}).catch(() => 'page gone');
	const cfg = await fetchJson(`http://127.0.0.1:${spineHttp}/v2/config`).catch(() => 'fetch failed');
	console.log(`[host-moment ${client.name}] ui=${JSON.stringify(ui)} spine=${JSON.stringify(cfg.body?.capacity ?? cfg)}`);
}

// The maker's flow: fill the host fields, choose the spectator switch, press
// the host button — the POST goes to the SPINE (no local node exists).
// A node can read zero capacity for honest transient reasons (spine-tunnel
// rotation, rtt ≥ 80 ms under load, the sampler's health gate) while the rig
// boots and rotates matches; a create POSTed into that window is refused with
// no-capacity, so wait the transition out before pressing Host.
async function createCommunityRoom(client, uid, slots, roomName) {
	await waitFor(async () => {
		try {
			const cfg = await fetchJson(`http://127.0.0.1:${spineHttp}/v2/config`);
			return (cfg.body?.capacity?.donatedFree ?? 0) >= 1;
		} catch { return false; }
	}, 120_000, 'placement capacity (node rotation/eligibility recovers)');
	await selectSeatMap(client, [uid]);
	await client.page.click('#session-tab-mp');
	await client.page.waitForFunction(() => (document.getElementById('session-mp-slots')?.options?.length ?? 0) > 0, undefined, { timeout: 30_000, polling: 250 });
	await client.page.selectOption('#session-mp-slots', String(slots));
	await client.page.fill('#session-mp-name', client.name);
	await client.page.fill('#session-mp-roomname', roomName);
	await client.page.check('#session-mp-spectate');
	await dumpHostMoment(client);
	const before = nodeA.log.filter(l => /spine room [0-9a-f]{16} created/.test(l)).length;
	await client.page.click('#session-mp-host');
	const line = await waitFor(() => {
		const hits = nodeA.log.filter(l => /spine room [0-9a-f]{16} created/.test(l));
		return hits.length > before ? hits[hits.length - 1] : null;
	}, 60_000, 'the spine placed the room on the standing node');
	const roomId = /spine room ([0-9a-f]{16}) created/.exec(line)[1];
	await waitProbe(client, /state=Connected/, 90_000, 'maker joined the placed room');
	return roomId;
}

async function joinRoomRow(client, roomId) {
	await client.page.click('#session-tab-mp');
	await client.page.fill('#session-mp-name', client.name);
	await waitFor(() => client.page.evaluate(id => {
		const row = document.querySelector(`#session-mp-rooms-body tr[data-room-id="${id}"]`);
		const button = row?.querySelector('td.room-join button');
		if (!row || !button || button.disabled) return false;
		button.click();
		return true;
	}, roomId), 60_000, `${client.name} joinable row ${roomId.slice(0, 8)}`);
	await waitProbe(client, /state=Connected/, 90_000, `${client.name} joined through the spine tunnel`);
}

// Lobby entries from probeLobby(): name|bot:…|…|admin:True|slot:<id|none>|idx:…
async function lobbyEntryFor(client, name) {
	return await client.page.evaluate(async who => {
		const lobby = await globalThis.steelseedBridge.probeLobby();
		const entries = (/clients=\[(.*)\]/.exec(lobby)?.[1] ?? '').split(';;').filter(Boolean);
		return entries.find(e => e.startsWith(`${who}|`)) ?? '';
	}, name);
}

// Lobby state is eventually-consistent from the client's view: an order
// (spectate, seat claim) needs a server round trip plus a lobby sync before
// probeLobby() reflects it. Assert on it only through this poll.
async function waitForLobbyEntry(client, name, test, ms, label) {
	return await waitFor(async () => {
		const entry = await lobbyEntryFor(client, name);
		return entry && test(entry) ? entry : null;
	}, ms, `${label} (last: ${await lobbyEntryFor(client, name)})`);
}

async function startButtonState(client) {
	return await client.page.evaluate(() => {
		const bar = document.querySelector('#mp-setup .mp-lobby-actions');
		const button = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent === 'Start match') : null;
		return button ? { found: true, disabled: button.disabled } : { found: false, disabled: true };
	});
}

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

async function clickAdminStart(client) {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (/started=True/.test(await client.page.evaluate(() => globalThis.ora.GetConnectionProbe()))) return;
		const state = await startButtonState(client);
		if (state.found && !state.disabled) {
			await client.page.evaluate(() => {
				const bar = document.querySelector('#mp-setup .mp-lobby-actions');
				const button = [...bar.querySelectorAll('button')].find(b => b.textContent === 'Start match');
				button.click();
			});
			console.log(`[${client.name}] spectating admin pressed Start match`);
			return;
		}
		await sleep(1000);
	}
	throw new Error(`[${client.name}] the admin Start match button never became pressable`);
}

async function leaveRoom(client) {
	const clicked = await client.page.evaluate(() => {
		const bar = document.querySelector('#mp-setup .mp-lobby-actions');
		const button = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent === 'Leave game') : null;
		if (!button) return false;
		button.click();
		return true;
	});
	if (!clicked) throw new Error(`[${client.name}] Leave game button missing`);
	await waitFor(() => client.page.evaluate(() => !/state=Connected/.test(globalThis.ora.GetConnectionProbe())), 30_000, `${client.name} left the room`);
}

// Polling helpers: a node that is still booting refuses connections, which a
// waitFor poll must treat as "not yet", never as a gate failure.
async function nodeRooms(node) {
	return await fetchJson(`http://127.0.0.1:${node.http}/v2/rooms`)
		.then(list => list.body?.rooms ?? []).catch(() => []);
}

async function spineRoomRow(roomId) {
	return await fetchJson(`http://127.0.0.1:${spineHttp}/v2/rooms`)
		.then(list => (list.body?.rooms ?? []).find(r => r.roomId === roomId) ?? null)
		.catch(() => null);
}

async function dumpCloseInfo(banner) {
	console.error(`--- ${banner} ---`);
	for (const c of clients) {
		const probe = await c.page.evaluate(() => globalThis.ora.GetConnectionProbe()).catch(() => 'page gone');
		const status = await c.page.evaluate(() => document.getElementById('session-mp-status')?.textContent ?? '').catch(() => '?');
		const wsTap = await c.page.evaluate(() => globalThis.__wsTap ?? []).catch(() => '?');
		const history = await c.page.evaluate(() => globalThis.__statusHistory ?? []).catch(() => '?');
		console.error(`[${c.name}] status="${String(status).slice(0, 120)}" ${probe}`);
		// The room-list poll rewrites the status every 5 s; the join verdict is
		// one flash among them. Filter the noise out and keep the recent events.
		const events = Array.isArray(history) ? history.filter(h => !/network rooms found/.test(h.text)) : history;
		if (Array.isArray(events) && events.length)
			console.error(`[${c.name}] status-events=${JSON.stringify(events.slice(-10))}`);
		// The transport's own verdict for the most recent close: code, reason,
		// and (after the fix) when it was recorded — a close older than the
		// join start is a previous session's corpse and must not abort it.
		const mpClose = await c.page.evaluate(() => globalThis.steelseedBridge?.getMpCloseInfo?.()).catch(() => '?');
		console.error(`[${c.name}] mpClose=${JSON.stringify(mpClose)}`);
		console.error(`[${c.name}] ws=${typeof wsTap === 'string' ? wsTap : JSON.stringify(wsTap.slice(-6))}`);
		if (Array.isArray(c.consoleRing) && c.consoleRing.length)
			console.error(`[${c.name}] console-tail:\n  ${c.consoleRing.slice(-24).join('\n  ')}`);
	}
	for (const n of [nodeA, nodeB]) if (n.log) console.error(`--- ${n === nodeA ? 'node A' : 'node B'} tail ---\n${n.log.slice(-10).join('\n')}`);
	if (spine.log) console.error(`--- spine tail ---\n${spine.log.slice(-12).join('\n')}`);
}

let result = 'MILESTONE INCOMPLETE';
let stopCapacityWatch = null;
let chromium = null;
try {
	chromium = await loadChromium('mp-communitygate');

	// ---- rig: spine (placement on, limits relaxed for the one local IP) ----
	spine.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'communitygate-spine-'));
	spine.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'communitygate-config-'));
	fs.writeFileSync(path.join(spine.configDir, 'relay.json'), JSON.stringify({
		placement: 'donated', browserMultiplayer: 'full',
	}));
	spine.proc = spawnProcessGroup(process.execPath, [spineScript,
		'--http', String(spineHttp), '--ws', String(spineWs),
		'--data-dir', spine.tmp, '--config', path.join(spine.configDir, 'relay.json'),
	], { stdio: 'pipe', env: { ...process.env, REDLINE_SPINE_RELAX_ROOM_LIMITS: '1' } });
	spine.log = attach('spine', spine.proc);
	await waitFor(() => fetchJson(`http://127.0.0.1:${spineHttp}/v2/config`).then(r => r.status === 200).catch(() => false), 15_000, 'spine http up');

	// ---- patched bundle: net-config points the pages at the local spine ----
	const bundleCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'communitygate-bundle-'));
	fs.cpSync(path.join(engineRoot, 'bin-browser/AppBundle'), bundleCopy, { recursive: true });
	const netConfigPath = path.join(bundleCopy, 'steelseed/net-config.json');
	const netConfig = JSON.parse(fs.readFileSync(netConfigPath, 'utf8'));
	netConfig.relay = `http://127.0.0.1:${spineHttp}`;
	netConfig.browserMultiplayer = 'full';
	fs.writeFileSync(netConfigPath, JSON.stringify(netConfig));

	// ---- node A: standing, placement opt-in, idle admin demotion ----
	const twoSeatMaps = resolveMapCandidates(2);
	const roomsFile = { schema: 1, rooms: [
		{ name: 'Community room one', slots: 2, password: '', maps: [twoSeatMaps[0]], settings: { gamespeed: 'default', tod: 'auto', weather: 'on' } },
		{ name: 'Community room two', slots: 2, password: '', maps: [twoSeatMaps[1] ?? twoSeatMaps[0]], settings: { gamespeed: 'default', tod: 'auto', weather: 'on' } },
	] };
	nodeA.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'communitygate-a-'));
	fs.writeFileSync(path.join(nodeA.tmp, 'rooms.json'), JSON.stringify(roomsFile));
	nodeA.key = crypto.randomBytes(16).toString('hex');
	nodeA.proc = spawnProcessGroup(process.execPath, [roomhostScript,
		'--bundle', bundleCopy, '--ws', String(nodeA.ws), '--http', String(nodeA.http),
		'--base-port', String(nodeA.base), '--max-matches', '4', '--idle-kill', '90',
		'--spine', `ws://127.0.0.1:${spineWs}/node`, '--data-dir', nodeA.tmp,
		'--mode', 'standing', '--rooms-file', path.join(nodeA.tmp, 'rooms.json'),
		'--accept-placed', '--admin-idle-seconds', String(ADMIN_IDLE_SECONDS),
	], { stdio: 'pipe', env: { ...process.env, REDLINE_NODE_KEY: nodeA.key } });
	nodeA.log = attach('node-A', nodeA.proc);

	// ---- node B: plain donate (regression target) ----
	// Spawned LATE, right before the fallback phases: placement picks by RTT
	// and both nodes tie at ~1 ms locally, so a donate node that registers
	// first would win every create. With B absent, phases 1–5 place on the
	// standing node deterministically; 6a/6b then bring B in for the
	// slots-ceiling and full-node fallback proofs.
	await waitFor(async () => (await nodeRooms(nodeA)).length >= 2, 60_000, 'node A booted its two standing rooms');
	console.log('OK node A stands two always-on community rooms');
	stopCapacityWatch = watchCapacity();

	// ================= 1+2: maker spectates, players seat, match runs =================
	const maker = await bootClient(chromium, 'MakerCmd');
	const threeSeatMaps = resolveMapCandidates(3);
	const matchRoom = await createCommunityRoom(maker, threeSeatMaps[0], 3, 'CommunityGate');
	console.log(`OK spine placed room ${matchRoom} on the standing node (community)`);
	await waitFor(async () => (await spineRoomRow(matchRoom))?.hostKind === 'community', 30_000, 'the room lists as hostKind community');
	await waitForLobbyEntry(maker, maker.name, e => /admin:True/.test(e) && /slot:none/.test(e), 15_000, 'maker is a spectating admin');
	console.log('OK the maker is admin without a seat (slot:none, admin:True)');

	// Boot both players BEFORE anyone waits in a lobby: a wasm boot takes
	// minutes, the rig's idle-admin demotion fires in 45 s, and the waiting
	// admin would be demoted mid-boot. With everyone up front the lobby
	// windows stay seconds long.
	const playerOne = await bootClient(chromium, 'PlayerOne');
	const playerTwo = await bootClient(chromium, 'PlayerTwo');
	await joinRoomRow(playerOne, matchRoom);
	let start = await startButtonState(maker);
	if (!start.found || !start.disabled)
		throw new Error(`Start must stay disabled with one seated player: ${JSON.stringify(start)}`);
	console.log('OK Start stays disabled while only one player is seated');
	await waitForLobbyEntry(playerOne, playerOne.name, e => !/slot:none/.test(e) && /slot:/.test(e), 15_000, 'player one took a seat');

	await joinRoomRow(playerTwo, matchRoom);
	await waitFor(async () => {
		const state = await startButtonState(maker);
		return state.found && !state.disabled;
	}, 30_000, 'Start enables once two players are seated');
	console.log('OK Start enables at two seated players');

	await clickReady(playerOne);
	await clickReady(playerTwo);
	await clickReady(maker); // the spectating admin readies like anyone (L8)
	await clickAdminStart(maker);
	for (const c of [maker, playerOne, playerTwo]) await waitProbe(c, /started=True/, 240_000, 'game started');
	console.log('OK started=True on all three (spectating admin started the match)');

	const pair = createSyncSamples();
	const order = [playerOne, playerTwo];
	const startTick = [null, null];
	const lastTick = [null, null];
	const progressAt = [Date.now(), Date.now()];
	const began = Date.now();
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
			if (read.connection.includes('outofsync=True')) throw new Error(`outofsync flagged: ${read.connection}`);
			if (!read.connection.includes('state=Connected') || !read.connection.includes('started=True'))
				throw new Error(`match disconnected mid-window: ${read.connection}`);
			if (startTick[index] === null) startTick[index] = tick;
			if (lastTick[index] !== tick) progressAt[index] = Date.now();
			else if (Date.now() - progressAt[index] >= 1000) throw new Error(`${order[index].name} stalled at tick ${tick}`);
			lastTick[index] = tick;
			samples.push({ tick, hash: Number(match[2]) });
		}
		pair.add(0, [samples[0]]);
		pair.add(1, [samples[1]]);
		const makerProbe = await maker.page.evaluate(() => globalThis.ora.GetConnectionProbe());
		if (!/state=Connected/.test(makerProbe) || !/started=True/.test(makerProbe))
			throw new Error(`spectator lost the match: ${makerProbe}`);
		await sleep(20);
	} while (Date.now() - began < SAMPLE_SECONDS * 1000);
	const sync = pair.result();
	if (sync.matchedTicks < MIN_MATCHED_TICKS || sync.mismatches !== 0)
		throw new Error(`players did not tick-match: ${JSON.stringify(sync)}`);
	console.log(`OK two seated players matched ${sync.matchedTicks} ticks, mismatches=${sync.mismatches}; spectator stayed connected`);

	// ================= 3: the match survives the spectating maker leaving =================
	// OpenRA's dedicated server reassigns admin on disconnect only in the lobby
	// (Server.cs guards on WaitingPlayers; mid-match reassign is an upstream
	// TODO). Mid-match the room just plays on — admin has no in-match power.
	// The lobby reassign is proven live in phase 4 (idle demotion → new admin).
	await leaveRoom(maker);
	await waitFor(() => nodeA.log.some(l => /notification-observer-disconnected/.test(l)), 30_000, 'the server registered the spectator leaving');
	await waitProbe(playerOne, /state=Connected.*started=True/, 30_000, 'players survive the admin leaving');
	await waitProbe(playerTwo, /state=Connected.*started=True/, 30_000, 'players survive the admin leaving');
	console.log('OK the spectating maker left mid-match; players unaffected');
	await leaveRoom(playerOne);
	await leaveRoom(playerTwo);
	await waitFor(async () => !(await nodeRooms(nodeA)).some(r => r.roomId === matchRoom), 60_000, 'the match room ended after everyone left');
	console.log('OK the community match room closed cleanly');

	// ================= 4: idle demotion (alone exempt, then demoted) =================
	const idleRoom = await createCommunityRoom(maker, twoSeatMaps[0], 2, 'IdleGate');
	console.log(`OK second community room ${idleRoom} placed (node A now standing×2 + placed×1)`);
	await sleep(ALONE_WAIT_MS);
	if (nodeA.log.some(l => /admin idle-demoted/.test(l)))
		throw new Error('a maker waiting ALONE must never be demoted');
	console.log(`OK maker idle ${ALONE_WAIT_MS / 1000}s alone: no demotion (alone exempt)`);
	// Snapshot the demotion counter BEFORE the join: the maker has been idle
	// past the window by now, so the demotion fires the instant the waiter's
	// connection validates — during joinRoomRow's own Connected wait — and a
	// counter taken after the join would already include it.
	const beforeDemote = nodeA.log.filter(l => /admin idle-demoted/.test(l)).length;
	await joinRoomRow(playerOne, idleRoom);
	await waitFor(() => nodeA.log.filter(l => /admin idle-demoted/.test(l)).length > beforeDemote, DEMOTE_WAIT_MS,
		`the node demoted the silent admin (> ${ADMIN_IDLE_SECONDS}s) while a player waited`);
	console.log(`OK silent maker demoted after ${ADMIN_IDLE_SECONDS}s with someone waiting`);
	await waitFor(async () => {
		const entry = await lobbyEntryFor(playerOne, playerOne.name);
		return /admin:True/.test(entry);
	}, 30_000, 'the waiting player took admin');
	const makerGone = await lobbyEntryFor(playerOne, maker.name);
	if (makerGone) throw new Error(`the demoted maker still lingers in the lobby: ${makerGone}`);
	await waitProbe(playerOne, /state=Connected/, 30_000, 'the room survives the demotion');
	console.log('OK the waiting player is admin now and the room lives on');
	// The demotion force-closed the maker's socket one second ago; a page still
	// tearing down its lobby view is in no state to create the next room (the
	// ShareGate create below ran into exactly that in run 19: the POST placed
	// the room, the join never left the page). Let the HUD land back at the
	// session view before anyone presses Host again — what a human does too.
	await waitProbe(maker, /state=NotConnected/, 30_000, 'the demoted maker landed back at the session view');
	await sleep(5_000);

	// ================= 5: share-link deeplink joins seated =================
	// BEFORE node B exists (see the rig comment): placement picks by RTT, and
	// an idle donate node out-races a loaded standing node. With A as the only
	// candidate the create is deterministic; playerOne keeps the idle room
	// alive, so A sits at 3/4 and this room fills it — which is what phase 6b's
	// overflow proof relies on.
	const shareRoom = await createCommunityRoom(maker, twoSeatMaps[0], 2, 'ShareGate');
	console.log(`OK third community room ${shareRoom} placed (node A at --max-matches 4)`);
	await playerTwo.page.goto(`${PAGE_BASE}?mode=game&platform=null&mp=1&Player.Name=${playerTwo.name}&room=${shareRoom}`);
	await playerTwo.page.waitForFunction(() => typeof globalThis.ora !== 'undefined' && globalThis.ora.IsRunning?.(), undefined, { timeout: 240_000, polling: 250 });
	await waitProbe(playerTwo, /state=Connected/, 120_000, 'the share link joined the room');
	await waitForLobbyEntry(playerTwo, playerTwo.name, e => !/slot:none/.test(e) && /slot:/.test(e), 15_000, 'the share link took a seat');
	console.log('OK ?room= deeplink joined the community room seated');

	// ================= 6a: slots 5 skips the standing node (it has capacity) =================
	// Bring the donate node in now (see the rig comment): node A is full at
	// 4/4, so donatedFree jumping to ≥2 means B is registered, healthy and
	// RTT-sampled — exactly the eligibility the POST below relies on.
	nodeB.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'communitygate-b-'));
	nodeB.key = crypto.randomBytes(16).toString('hex');
	nodeB.proc = spawnProcessGroup(process.execPath, [roomhostScript,
		'--bundle', bundleCopy, '--ws', String(nodeB.ws), '--http', String(nodeB.http),
		'--base-port', String(nodeB.base), '--max-matches', '2', '--idle-kill', '90',
		'--spine', `ws://127.0.0.1:${spineWs}/node`, '--data-dir', nodeB.tmp,
		'--mode', 'donate',
	], { stdio: 'pipe', env: { ...process.env, REDLINE_NODE_KEY: nodeB.key } });
	nodeB.log = attach('node-B', nodeB.proc);
	await waitFor(async () => (await fetchJson(`http://127.0.0.1:${spineHttp}/v2/config`)).body?.capacity?.donatedFree >= 2, 30_000,
		'the donate node joined the placement pool (donatedFree ≥ 2)');
	console.log('OK the donate node is in the pool for the fallback proofs');

	const fiveSeatMaps = resolveMapCandidates(5);
	const big = await fetchJson(`http://127.0.0.1:${spineHttp}/v2/rooms`, {
		method: 'POST', headers: { 'content-type': 'application/json', origin: PAGE_ORIGIN },
		body: JSON.stringify({ map: fiveSeatMaps[0], slots: 5, name: 'Big community ask' }),
	});
	if (big.status !== 201 || big.body?.room?.hostKind !== 'donated')
		throw new Error(`slots-5 must fall through to donate: ${big.status} ${JSON.stringify(big.body).slice(0, 160)}`);
	if ((await nodeRooms(nodeA)).some(r => r.roomId === big.body.room.roomId))
		throw new Error('the standing node must never take a five-seat placed room');
	await waitFor(() => nodeB.log.some(l => l.includes(big.body.room.roomId)), 15_000, 'the donate node served the five-seat room');
	console.log('OK slots 5 skipped the standing node (community ceiling) and the donate node took it');
	const deleted = await fetchJson(`http://127.0.0.1:${nodeB.http}/v2/rooms/${big.body.room.roomId}`, {
		method: 'DELETE', headers: { 'content-type': 'application/json', 'x-redline-node-key': nodeB.key },
	});
	if (deleted.status !== 204) throw new Error(`keyed delete on the donate node failed: ${deleted.status}`);

	// ================= 6b: full standing node falls back to donate =================
	if ((await nodeRooms(nodeA)).length !== 4)
		throw new Error(`node A should stand at 4/4 rooms now: ${(await nodeRooms(nodeA)).map(r => r.roomId).join(',')}`);
	const overflow = await fetchJson(`http://127.0.0.1:${spineHttp}/v2/rooms`, {
		method: 'POST', headers: { 'content-type': 'application/json', origin: PAGE_ORIGIN },
		body: JSON.stringify({ map: twoSeatMaps[0], slots: 2, name: 'Overflow ask' }),
	});
	if (overflow.status !== 201 || overflow.body?.room?.hostKind !== 'donated')
		throw new Error(`a full standing node must fall back to donate: ${overflow.status} ${JSON.stringify(overflow.body).slice(0, 160)}`);
	if ((await nodeRooms(nodeA)).some(r => r.roomId === overflow.body.room.roomId))
		throw new Error('the full standing node must not take another room');
	console.log('OK the spine skipped the full standing node and the donate node answered');

	console.log(`=== RESULT: community placement, spectator-admin match (${sync.matchedTicks} matched ticks), admin-leave + idle demotion, share link, ceiling + fallback — all green ===`);
	result = 'MILESTONE PASS';
} catch (e) {
	console.error('FAILED:', e.message);
	await dumpCloseInfo('failure').catch(() => {});
} finally {
	stopCapacityWatch?.();
	for (const c of clients) await c.browser?.close().catch(() => {});
	if (spine.proc) await stopProcessGroup(spine.proc).catch(() => {});
	for (const n of [nodeA, nodeB]) if (n.proc) await stopProcessGroup(n.proc).catch(() => {});
	await sleep(1000);
	for (const tmp of [spine.tmp, spine.configDir, nodeA.tmp, nodeB.tmp]) {
		if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
	}
}
console.log(result);
process.exitCode = result === 'MILESTONE PASS' ? 0 : 1;
