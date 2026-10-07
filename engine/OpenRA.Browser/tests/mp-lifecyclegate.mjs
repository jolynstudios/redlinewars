// mp-lifecyclegate (T1.29) — one script, four independent runs.
//
// Each case boots the same relay plumbing as mp-relaygate (one spine with a
// temp --data-dir + one roomhost node with a generated REDLINE_NODE_KEY /
// REDLINE_NODE_TOKEN + GPU Chromium clients entering through the REAL
// session UI with ?mpdir=<spine>), then exercises exactly one lifecycle
// edge. §9.2:
//   (a) admin leaves the lobby → a remaining client shows S13
//       ("You are now the host.") and CAN start the match;
//   (b) node killed mid-match → both clients show S16 within 35 s and the
//       banner's Leave returns to the session screen;
//   (c) relay restarted → the node re-registers within 10 s and the room
//       list recovers;
//   (d) match ends → the room is gone from the node's /rooms within 5 s,
//       the dedicated server process exited, and the relay list retracts
//       the row within its report cadence.
// One PASS/FAIL line per case + an overall exit code.
//
// Usage: node mp-lifecyclegate.mjs [--case a|b|c|d]
import { loadChromium, launchGpuBrowser } from '../../../web/tools/harness.mjs';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(testsDir, '../..');
const roomhostScript = path.join(engineRoot, 'steelseed-host/tools/roomhost.mjs');
const spineScript = path.join(engineRoot, 'steelseed-host/tools/spine.mjs');
const generatedDir = path.join(engineRoot, 'steelseed-host/generated/mods/ra');
// Distinct port slices per case so a failed case can never poison the next.
const CASE_BASE = Number(process.env.LIFECYCLE_BASE ?? '13800');

const only = (() => {
	const i = process.argv.indexOf('--case');
	return i >= 0 ? process.argv[i + 1] : process.env.LIFECYCLE_CASE ?? null;
})();

// T1.27: the map pin comes from gate-map.json; seats beyond two need a
// catalog map with enough player slots (the node rejects slots above the
// map's player count), so fall through the catalog in generation order.
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
			if (/room |notification-|spine|player chan|state |register|connected|dedicated/.test(line)) console.log(`  [${label}] ${line.slice(0, 170)}`);
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
		await sleep(400);
	}
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
}

// ---- one rig per case: spine + node + client bookkeeping ----

async function startRig(slot) {
	const base = CASE_BASE + slot * 50;
	const rig = {
		slot,
		spine: { http: base, ws: base + 1, proc: null, log: null, tmp: null },
		node: { http: base + 2, ws: base + 3, base: base + 10, key: null, proc: null, log: null, tmp: null },
		clients: [],
		chromium: null,
	};
	const spineToken = crypto.randomBytes(16).toString('hex');
	rig.spineToken = spineToken;
	rig.spine.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `lifecyclegate-${slot}-spine-`));
	rig.spine.proc = spawnProcessGroup('node', [spineScript,
		'--http', String(rig.spine.http), '--ws', String(rig.spine.ws),
		'--data-dir', rig.spine.tmp,
	], { stdio: 'pipe', env: { ...process.env, STEELSEED_NODE_TOKEN: spineToken } });
	rig.spine.log = attach(`spine-${slot}`, rig.spine.proc);
	rig.node.key = crypto.randomBytes(16).toString('hex');
	rig.node.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `lifecyclegate-${slot}-node-`));
	rig.node.proc = spawnProcessGroup('node', [roomhostScript,
		'--bundle', path.join(engineRoot, 'bin-browser/AppBundle'),
		'--ws', String(rig.node.ws), '--http', String(rig.node.http),
		'--base-port', String(rig.node.base), '--max-matches', '2',
		'--spine', `ws://127.0.0.1:${rig.spine.ws}/node`,
		'--data-dir', rig.node.tmp,
	], { stdio: 'pipe', env: { ...process.env, REDLINE_NODE_KEY: rig.node.key, REDLINE_NODE_TOKEN: spineToken } });
	rig.node.log = attach(`node-${slot}`, rig.node.proc);
	await waitFor(() => fetchJson(`http://127.0.0.1:${rig.spine.http}/nodes`).then(r => r.status === 200).catch(() => false), 15_000, `rig ${slot} spine http up`);
	await waitFor(async () => {
		const seen = await fetchJson(`http://127.0.0.1:${rig.spine.http}/nodes`).catch(() => ({ body: [] }));
		return seen.body.length === 1;
	}, 20_000, `rig ${slot} node registered`);
	return rig;
}

async function stopRig(rig) {
	for (const c of rig.clients) await c.browser?.close().catch(() => {});
	if (rig.spine.proc) await stopProcessGroup(rig.spine.proc).catch(() => {});
	if (rig.node.proc) await stopProcessGroup(rig.node.proc).catch(() => {});
	await sleep(750);
	for (const tmp of [rig.spine.tmp, rig.node.tmp]) {
		if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
	}
}

function spineRoomCreated(rig, afterCount) {
	const lines = rig.spine.log.filter(l => /room \S+ created on node/.test(l));
	if (lines.length <= afterCount) return null;
	return /room (\S+) created on node/.exec(lines[lines.length - 1])[1];
}

async function dumpCloseInfo(rig, banner) {
	console.error(`  --- ${banner}: getMpCloseInfo() per client ---`);
	for (const c of rig.clients) {
		const close = await c.page.evaluate(async () => {
			try { return await globalThis.steelseedBridge.getMpCloseInfo(); }
			catch (e) { return { error: String(e).slice(0, 120) }; }
		}).catch(e => ({ error: `page gone: ${String(e).slice(0, 80)}` }));
		const probe = await c.page.evaluate(() => globalThis.ora.GetConnectionProbe())
			.catch(e => `probe unavailable: ${String(e).slice(0, 80)}`);
		console.error(`  [${c.name}] close=${JSON.stringify(close)}\n    probe=${probe}`);
	}
}

async function waitProbe(client, re, timeoutMs, label) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const probe = await client.page.evaluate(() => globalThis.ora.GetConnectionProbe());
		if (re.test(probe)) return probe;
		if (Date.now() > end) {
			const status = await client.page.evaluate(() => document.getElementById('session-status')?.textContent ?? 'absent').catch(e => `unavailable: ${String(e).slice(0, 80)}`);
			throw new Error(`TIMEOUT ${label} [${client.name}]\n  ${probe}\n  session-status: ${status}`);
		}
		await sleep(1000);
	}
}

async function bootClient(rig, name) {
	if (!rig.chromium) rig.chromium = await loadChromium(`mp-lifecyclegate-${rig.slot}`);
	const gpu = await launchGpuBrowser(rig.chromium, `mp-lifecyclegate-${rig.slot}`);
	const page = await gpu.browser.newPage();
	const client = { name, browser: gpu.browser, page };
	rig.clients.push(client); // register immediately: a later boot failure must still close it
	page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e).slice(0, 200)));
	// Publish the keyed local-node surface before the UI reads its mode switch;
	// late injection cannot reveal the host controls that were already gated.
	await page.addInitScript(({ dir, key }) => {
		globalThis.__redlineLocalNode = { dir, key };
	}, { dir: `http://127.0.0.1:${rig.node.http}`, key: rig.node.key });
	await page.goto(`http://127.0.0.1:${rig.node.http}/steelseed/index.html?mode=game&platform=null&mp=1&mpdir=http://127.0.0.1:${rig.spine.http}&Player.Name=${name}`);
	await page.waitForFunction(() => typeof globalThis.steelseed !== 'undefined' && typeof globalThis.ora !== 'undefined' && typeof globalThis.steelseedBridge !== 'undefined', undefined, { timeout: 240_000, polling: 250 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000, polling: 250 });
	await page.waitForFunction(() => document.getElementById('session-start') instanceof HTMLButtonElement && document.getElementById('session-start').disabled === false, undefined, { timeout: 60_000, polling: 250 });
	console.log(`  [${name}] booted`);
	return client;
}

async function selectSeatMap(client, candidates) {
	const chosen = await client.page.evaluate(uids => {
		const options = [...document.querySelectorAll('#session-map option')].map(o => o.value);
		return uids.find(uid => options.includes(uid)) ?? null;
	}, candidates);
	if (!chosen) throw new Error(`[${client.name}] #session-map offers none of ${candidates[0]}…`);
	await client.page.selectOption('#session-map', chosen);
	return chosen;
}

async function hostRoom(rig, client, candidates, slots, roomName) {
	await selectSeatMap(client, candidates);
	await client.page.click('#session-tab-mp');
	await client.page.waitForFunction(() => (document.getElementById('session-mp-slots')?.options?.length ?? 0) > 0, undefined, { timeout: 30_000, polling: 250 });
	await client.page.selectOption('#session-mp-slots', String(slots));
	await client.page.fill('#session-mp-name', client.name);
	await client.page.fill('#session-mp-roomname', roomName);
	// §5.9 local-node hook: the host page creates on ITS OWN node (the node
	// directory is what the host's client uses in the v1 topology, §4.5); the
	// relay only lists and tunnels. T2.6/T2.8 removed the relay-create path.
	await client.page.evaluate(({ dir, key }) => {
		globalThis.__redlineLocalNode = { dir, key };
		const raw = globalThis.fetch.bind(globalThis);
		globalThis.__mpFetchLog = [];
	}, { dir: `http://127.0.0.1:${rig.node.http}`, key: rig.node.key });
	const beforeRooms = await fetchJson(`http://127.0.0.1:${rig.node.http}/v2/rooms`);
	const known = new Set((beforeRooms.body?.rooms ?? []).map(r => r.roomId));
	// This gate tests room lifecycle, not overload rejection. On a busy shared
	// development Mac the node correctly advertises zero capacity; wait for
	// stable free capacity before asking the UI to create its test room.
	let freeSince = 0;
	await waitFor(async () => {
		const health = await fetchJson(`http://127.0.0.1:${rig.node.http}/v2/health`);
		if (health.status !== 200 || Number(health.body?.freeMatches ?? 0) < 1) {
			freeSince = 0;
			return false;
		}
		if (!freeSince) freeSince = Date.now();
		return Date.now() - freeSince >= 5_000;
	}, 240_000, 'stable local node capacity for lifecycle test');
	await client.page.click('#session-mp-host');
	try {
		var roomId = await waitFor(async () => {
			const list = await fetchJson(`http://127.0.0.1:${rig.node.http}/v2/rooms`);
			return (list.body?.rooms ?? []).map(r => r.roomId).find(id => !known.has(id)) ?? null;
		}, 60_000, 'host-flow room create on the node');
	} catch (createError) {
		const diag = await client.page.evaluate(() => ({
			slots: document.getElementById('session-mp-slots')?.value ?? 'absent',
			map: document.getElementById('session-map')?.value ?? 'absent',
			mpStatus: document.getElementById('session-mp-status')?.textContent ?? 'absent',
			sessionStatus: document.getElementById('session-status')?.textContent ?? 'absent',
			hook: globalThis.__redlineLocalNode ? 'set' : 'unset',
			fetches: (globalThis.__mpFetchLog ?? []).slice(-6),
		})).catch(e => ({ diagError: String(e).slice(0, 100) }));
		throw new Error(`${String(createError).slice(0, 120)} | page: ${JSON.stringify(diag)}`);
	}
	// The creator's own join carries the room from reserved to lobby, which
	// is when the node first advertises it through the relay.
	await waitProbe(client, /state=Connected/, 90_000, 'host joined the room');
	await waitFor(async () => {
		const list = await fetchJson(`http://127.0.0.1:${rig.spine.http}/rooms`);
		return (list.body ?? []).some(r => r.roomId === roomId);
	}, 30_000, 'room advertised on the relay');
	console.log(`  room ${roomId} live in the relay list (${slots} seats)`);
	return roomId;
}

async function joinRoomRow(client) {
	await client.page.click('#session-tab-mp');
	await client.page.fill('#session-mp-name', client.name);
	// §5.10: wait for a join to begin before deciding whether to retry the click.
	// A second click while the first join is in flight disconnects that tunnel.
	for (let attempt = 1; attempt <= 12; attempt++) {
		// mpStatus() writes #session-status; #session-mp-status is only the
		// periodically refreshed room-list count and cannot acknowledge a join.
		const before = await client.page.evaluate(() => document.getElementById('session-status')?.textContent ?? '');
		const clicked = await client.page.evaluate(() => {
			const button = document.querySelector('#session-mp-rooms-body td.room-join button');
			if (!button) return false;
			button.click();
			return true;
		});
		if (clicked) {
			const accepted = await waitFor(() => client.page.evaluate(prev => {
				const probe = globalThis.ora.GetConnectionProbe();
				const status = document.getElementById('session-status')?.textContent ?? '';
				return /state=Connected/.test(probe) || (status !== prev && !/Network join failed/i.test(status));
			}, before), 10_000, `${client.name} join accepted`).catch(() => false);
			if (accepted) {
				await waitProbe(client, /state=Connected/, 90_000, 'joined through the tunnel');
				return;
			}
		}
		await sleep(1500);
	}
	throw new Error(`[${client.name}] Join never started after 12 attempts`);
}

async function waitInLobby(client, seats) {
	await client.page.waitForFunction(() => {
		const setup = document.getElementById('mp-setup');
		return !!setup && !setup.hidden && !!document.querySelector('#mp-setup .mp-lobby-actions');
	}, undefined, { timeout: 45_000, polling: 500 });
	await waitProbe(client, new RegExp(`clients=${seats}`), 45_000, `${seats} humans seated in the lobby`);
}

// L8: nobody is auto-readied — press the lobby's Ready button; its label
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
// NEVER startgame; the server's CheckAutoStart starts the match.
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
			console.log(`  [${client.name}] admin pressed Start match`);
			return;
		}
		await sleep(1000);
	}
	throw new Error(`[${client.name}] the admin Start match button never became pressable`);
}

// The lobby bar's Leave game button (§5.10 row "Leave", every phase).
async function clickLobbyLeave(client) {
	const clicked = await client.page.evaluate(() => {
		const bar = document.querySelector('#mp-setup .mp-lobby-actions');
		const button = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent === 'Leave game') : null;
		if (!button) return false;
		button.click();
		return true;
	});
	if (!clicked) throw new Error(`[${client.name}] Leave game button missing`);
	// After a leave the torn-down session reports "no connection" (fresh
	// disconnect) or "state=local" (JoinLocal already replaced it) — never
	// the lobby's NetworkConnection state.
	await waitProbe(client, /no connection|state=NotConnected|state=local/, 20_000, 'left the room');
}

// ---- cases ----

// (a) admin leaves the lobby → a remaining client shows S13 and can start.
// Three seats: after the handover two humans remain, so the new admin's
// Start match button is enabled (it stays disabled below two humans).
async function caseAdminLeaves(rig) {
	const candidates = resolveMapCandidates(3);
	const admin = await bootClient(rig, 'AlphaCmd');
	await hostRoom(rig, admin, candidates, 3, 'LifecycleA');
	const bravo = await bootClient(rig, 'BravoCmd');
	const charlie = await bootClient(rig, 'CharlieCmd');
	await joinRoomRow(bravo);
	await joinRoomRow(charlie);
	for (const c of [admin, bravo, charlie]) await waitInLobby(c, 3);

	await clickLobbyLeave(admin);
	console.log('  admin left the lobby');

	// Exactly one of the remaining clients inherits admin and shows S13.
	const s13 = 'You are now the host.';
	const handover = await waitFor(async () => {
		const statuses = await Promise.all([bravo, charlie].map(c =>
			c.page.evaluate(() => document.getElementById('session-status')?.textContent ?? '')));
		const flagged = [bravo, charlie].filter((c, i) => statuses[i].includes(s13));
		if (flagged.length === 1) return flagged[0];
		if (flagged.length > 1) throw new Error('S13 shown on more than one client');
		return null;
	}, 25_000, 'S13 handover banner on exactly one client');
	console.log(`  [${handover.name}] shows S13 — admin handover`);
	const other = handover === bravo ? charlie : bravo;
	const otherStatus = await other.page.evaluate(() => document.getElementById('session-status')?.textContent ?? '');
	if (otherStatus.includes(s13)) throw new Error('S13 shown on both remaining clients');

	// …and can start: the Start match button appears for the new admin and
	// the match really starts on both remaining clients.
	await handover.page.waitForFunction(() => {
		const bar = document.querySelector('#mp-setup .mp-lobby-actions');
		const start = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent === 'Start match') : null;
		return !!start && !start.hidden && !start.disabled;
	}, undefined, { timeout: 20_000, polling: 250 });
	console.log(`  [${handover.name}] Start match is visible and enabled`);
	await clickAdminStart(handover);
	// L8: the Start press readies only the admin (CheckAutoStart starts the
	// match when EVERY human is Ready) — the last human readies via the
	// Ready button while the lobby note shows "Waiting for 1 player…".
	await clickReady(other);
	for (const c of [handover, other]) await waitProbe(c, /started=True/, 240_000, 'game started after handover');
	console.log('  started=True on both remaining clients');
}

// (b) node killed mid-match → both clients show S16 within 35 s and the
// banner's Leave returns to the session screen.
async function caseNodeKilled(rig) {
	const candidates = resolveMapCandidates(2);
	const admin = await bootClient(rig, 'AlphaCmd');
	await hostRoom(rig, admin, candidates, 2, 'LifecycleB');
	const joiner = await bootClient(rig, 'BravoCmd');
	await joinRoomRow(joiner);
	for (const c of [admin, joiner]) await waitInLobby(c, 2);
	await clickReady(admin);
	await clickReady(joiner);
	await clickAdminStart(admin);
	for (const c of [admin, joiner]) await waitProbe(c, /started=True/, 240_000, 'game started');
	console.log('  match running — killing the node');

	await stopProcessGroup(rig.node.proc);
	const killedAt = Date.now();
	// S16 lands once the relay tears the players' channels (code 1011, the
	// node's tunnel went away). The liveness budget §5.5 allows is 35 s.
	const deadline = Date.now() + 35_000;
	for (const c of [admin, joiner]) {
		await c.page.waitForFunction(() => {
			const banner = document.getElementById('mp-match-banner');
			if (!banner || banner.hidden) return false;
			return (banner.querySelector('.mp-banner-text')?.textContent ?? '').startsWith('Connection lost');
		}, undefined, { timeout: Math.max(1000, deadline - Date.now()), polling: 500 });
		console.log(`  [${c.name}] S16 banner shown ${Math.round((Date.now() - killedAt) / 100) / 10}s after the kill`);
	}
	for (const c of [admin, joiner]) {
		const close = await c.page.evaluate(async () => globalThis.steelseedBridge.getMpCloseInfo());
		if (!close || close.code === 0) throw new Error(`[${c.name}] no transport close recorded: ${JSON.stringify(close)}`);
	}
	// Leave works: the banner action tears the session down WITHOUT a reload
	// and the session screen comes back.
	for (const c of [admin, joiner]) {
		await c.page.evaluate(() => {
			const banner = document.getElementById('mp-match-banner');
			const action = banner?.querySelector('button');
			if (action) action.click();
		});
		await c.page.waitForFunction(() => {
			const root = document.getElementById('session-ui');
			return !!root && !root.hidden;
		}, undefined, { timeout: 15_000, polling: 250 });
		console.log(`  [${c.name}] Leave returned to the session screen`);
	}
}

// (c) relay restarted → the node re-registers within 10 s and the room list
// recovers.
async function caseRelayRestart(rig) {
	const candidates = resolveMapCandidates(2);
	const admin = await bootClient(rig, 'AlphaCmd');
	const roomId = await hostRoom(rig, admin, candidates, 2, 'LifecycleC');
	console.log(`  restarting the relay (room ${roomId} sits in the lobby)`);

	await stopProcessGroup(rig.spine.proc).catch(() => {});
	rig.spine.proc = spawnProcessGroup('node', [spineScript,
		'--http', String(rig.spine.http), '--ws', String(rig.spine.ws),
		'--data-dir', rig.spine.tmp,
	], { stdio: 'pipe', env: { ...process.env, STEELSEED_NODE_TOKEN: rig.spineToken } });
	rig.spine.log = attach(`spine-${rig.slot}-2`, rig.spine.proc);
	await waitFor(() => fetchJson(`http://127.0.0.1:${rig.spine.http}/nodes`).then(r => r.status === 200).catch(() => false), 15_000, 'restarted relay http up');

	// The node redials after its fixed 3 s backoff and re-registers on open.
	const t0 = Date.now();
	await waitFor(async () => {
		const seen = await fetchJson(`http://127.0.0.1:${rig.spine.http}/nodes`).catch(() => ({ body: [] }));
		return seen.body.length === 1;
	}, 10_000, 'node re-registered within 10 s');
	console.log(`  node re-registered in ${Math.round((Date.now() - t0) / 100) / 10}s`);

	// The room list recovers: the node re-reports its live lobby room.
	await waitFor(async () => {
		const list = await fetchJson(`http://127.0.0.1:${rig.spine.http}/rooms`).catch(() => ({ body: [] }));
		return (list.body ?? []).some(r => r.roomId === roomId);
	}, 10_000, 'room list recovered');
	console.log(`  room ${roomId} back in the relay list`);
}

// (d) match ends → room gone from /rooms within 5 s, server process exited.
async function caseMatchEnds(rig) {
	const candidates = resolveMapCandidates(2);
	const admin = await bootClient(rig, 'AlphaCmd');
	const roomId = await hostRoom(rig, admin, candidates, 2, 'LifecycleD');
	const joiner = await bootClient(rig, 'BravoCmd');
	await joinRoomRow(joiner);
	for (const c of [admin, joiner]) await waitInLobby(c, 2);
	await clickReady(admin);
	await clickReady(joiner);
	await clickAdminStart(admin);
	for (const c of [admin, joiner]) await waitProbe(c, /started=True/, 240_000, 'game started');
	// The room's pidfile names the dedicated server process exactly (the
	// node writes it at spawn, T1.6) — a hermetic exit proof, unlike a
	// system-wide process scan that foreign matches would poison.
	const pidFile = path.join(rig.node.tmp, 'rooms', roomId, 'server.pid');
	const serverPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
	if (!Number.isInteger(serverPid) || serverPid <= 0 || !processAlive(serverPid))
		throw new Error(`no live dedicated server behind ${pidFile}`);

	// Both players leave the match (LeaveMultiplayer — §5.10 "Leave"). The
	// dedicated shuts down only when the LAST player drops, so issue every
	// Leave before waiting on anyone and wait each client's disconnect out
	// afterwards: one client's leave must never be gated on another's probe.
	for (const c of [admin, joiner]) {
		const outcome = await c.page.evaluate(() => globalThis.ora.LeaveMultiplayer());
		if (outcome !== 'left') throw new Error(`[${c.name}] LeaveMultiplayer refused: ${outcome}`);
	}
	console.log('  leave issued on both clients');
	for (const c of [admin, joiner]) {
		await waitProbe(c, /no connection|state=NotConnected|state=local/, 30_000, 'left the match');
	}
	console.log('  both clients left the match');

	// t0 = the match end (the last client's disconnect): from here the room
	// must vanish from /rooms within 5 s (§9.2), once the dedicated exits.
	const tEnd = Date.now();
	await waitFor(() => rig.node.log.some(l => l.includes('dedicated exited')), 45_000, 'dedicated exited after the match ended');
	// The node's /rooms is the authoritative directory: gone within 5 s.
	await waitFor(async () => {
		const list = await fetchJson(`http://127.0.0.1:${rig.node.http}/v2/rooms`);
		return (list.body?.rooms ?? []).every(r => r.roomId !== roomId);
	}, 5_000, `room gone from the node's /rooms within 5 s`);
	console.log(`  room gone from /rooms in ${Math.round((Date.now() - tEnd) / 100) / 10}s`);
	await waitFor(() => !processAlive(serverPid), 5_000, 'dedicated server process exited');
	console.log(`  dedicated server pid ${serverPid} exited`);
	// The relay retracts the row on the node's next 10 s report cadence.
	await waitFor(async () => {
		const list = await fetchJson(`http://127.0.0.1:${rig.spine.http}/v2/rooms`).catch(() => ({ body: [] }));
		return (list.body?.rooms ?? []).every(r => r.roomId !== roomId);
	}, 15_000, 'relay list retracted the ended room');
	console.log('  relay list retracted the ended room');
}

// ---- runner ----

const CASES = [
	{ id: 'a', label: 'admin leave hands over S13 and the new admin can start', run: caseAdminLeaves },
	{ id: 'b', label: 'node killed mid-match shows S16 within 35 s and Leave works', run: caseNodeKilled },
	{ id: 'c', label: 'relay restarted re-registers the node within 10 s and the list recovers', run: caseRelayRestart },
	{ id: 'd', label: 'match end removes the room within 5 s and exits the server', run: caseMatchEnds },
];

let failures = 0;
const ran = [];
for (const [slot, c] of CASES.entries()) {
	if (only && c.id !== only) continue;
	ran.push(c.id);
	const begin = Date.now();
	let rig = null;
	try {
		rig = await startRig(slot);
		await c.run(rig);
		console.log(`mp-lifecyclegate (${c.id}) ${c.label}: PASS (${Math.round((Date.now() - begin) / 1000)}s)`);
	} catch (e) {
		failures++;
		console.error(`mp-lifecyclegate (${c.id}) ${c.label}: FAIL — ${e.message}`);
		if (rig) await dumpCloseInfo(rig, `case ${c.id} failure`).catch(() => {});
	} finally {
		if (rig) await stopRig(rig);
	}
}
if (ran.length === 0) {
	console.error(`mp-lifecyclegate: no such case "${only}" (use a|b|c|d)`);
	process.exitCode = 1;
} else if (failures === 0) {
	console.log(`mp-lifecyclegate: PASS (${ran.length}/${ran.length} cases)`);
	process.exitCode = 0;
} else {
	console.log(`mp-lifecyclegate: FAIL (${ran.length - failures}/${ran.length} cases passed: ${ran.join(',')})`);
	process.exitCode = 1;
}
