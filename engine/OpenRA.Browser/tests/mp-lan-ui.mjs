// PR 3 gate: the REAL session-UI network flow. roomhost.mjs (LAN shape) serves
// the composed AppBundle over HTTP AND brokers rooms; two pages enter through
// the actual #session-ui buttons (`?mp=1` dev reveal): page A "Host on this
// network", page B joins via the ws endpoint. Both must reach in-game lockstep
// with outofsync=False. No direct export calls for the join lifecycle — this
// exercises the exact click path a LAN player takes.
//
// Usage: node mp-lan-ui.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser } from '../../../web/tools/harness.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..');
const dirPort = Number(process.env.LANUI_DIR ?? '13466'); // roomhost HTTP (static + rooms)
const muxPort = Number(process.env.LANUI_WS ?? '13465'); // roomhost WS mux
// T1.27: the map uid is owned by the generated mod, never a literal — the
// authoritative value is steelseed-host/generated/mods/ra/gate-map.json
// (written by steelseed-host/tools/build-ra-mod.mjs; the uid is the SHA1 of
// the generated map payload, so it moves when generation moves). argv/env
// stay as an explicit override for one-off runs.
const GATE = JSON.parse(fs.readFileSync(path.join(repoRoot, 'steelseed-host/generated/mods/ra/gate-map.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(GATE.uid ?? '')) throw new Error('gate-map.json has no uid — run steelseed-host/tools/build-ra-mod.mjs');
const mapUid = process.argv[2] ?? process.env.LANUI_MAP ?? GATE.uid;
const TARGET_FRAMES = 120;

// T1.9: the node's API is keyed — the gate generates the key, hands it to
// roomhost over env, and gives the pages the §5.9 local-node hook
// (window.__redlineLocalNode {dir,key}) so the REAL host button can POST
// with the header. The key never travels on argv or the URL.
const nodeKey = crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-ui-'));

const field = (probe, key) => new RegExp(`${key}=([^ ]+)`).exec(probe)?.[1] ?? '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitProbe(client, re, timeoutMs, label) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const probe = await client.page.evaluate(() => globalThis.ora.GetConnectionProbe());
		if (re.test(probe)) return probe;
		if (Date.now() > end) throw new Error(`TIMEOUT ${label} [${client.name}]\n  ${probe}`);
		await sleep(1000);
	}
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
			console.log(`[${client.name}] admin pressed Start match`);
			return;
		}
		await sleep(1000);
	}
	throw new Error(`[${client.name}] the admin Start match button never became pressable`);
}

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

const roomhost = spawn('node', [path.join(repoRoot, 'steelseed-host/tools/roomhost.mjs'),
	'--bundle', path.join(repoRoot, 'bin-browser/AppBundle'),
	'--ws', String(muxPort), '--http', String(dirPort),
	'--dedicated', path.join(repoRoot, 'launch-dedicated.sh'),
	'--base-port', String(Number(process.env.LANUI_BASE ?? '13470')),
	'--max-matches', '2',
	'--data-dir', dataDir,
], { stdio: 'pipe', env: { ...process.env, REDLINE_NODE_KEY: nodeKey } });
const roomhostLog = attach('roomhost', roomhost);
await new Promise(r => setTimeout(r, 1500));

let result = 'MILESTONE INCOMPLETE';
const launchArgs = [
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding'
];
const clients = [];
try {
	async function boot(name, query) {
		// The composed web UI requires the WebGPU renderer path (plain chromium
		// fails the foliage asset seam at boot).
		const gpu = await launchGpuBrowser(chromium, 'mp-lan-ui');
		const browser = gpu.browser;
		const page = await browser.newPage();
		page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e).slice(0, 200)));
		page.on('console', message => {
			if (message.type() === 'error' || /\[mp\]|network join/i.test(message.text()))
				console.error(`[${name} console:${message.type()}]`, message.text().slice(0, 300));
		});
		// §5.9 local-node hook: the page learns the local node's API directory
		// and key before any script runs, so the UI host flow is keyed.
		await page.addInitScript(({ dir, key }) => {
			globalThis.__redlineLocalNode = { dir, key };
		}, { dir: `http://127.0.0.1:${dirPort}`, key: nodeKey });
		await page.goto(`http://127.0.0.1:${dirPort}/steelseed/index.html?mode=game&platform=null&mp=1&Player.Name=${name}${query}`);
		// Composed boot contract: steelseed + ora + steelseedBridge. Never __s1_done.
		await page.waitForFunction(() => typeof globalThis.steelseed !== 'undefined' && typeof globalThis.ora !== 'undefined' && typeof globalThis.steelseedBridge !== 'undefined', undefined, { timeout: 240_000, polling: 250 });
		await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000, polling: 250 });
		// Wait for the session UI to be interactive (catalog rendered, start enabled).
		await page.waitForFunction(() => document.getElementById('session-start') instanceof HTMLButtonElement && document.getElementById('session-start').disabled === false, undefined, { timeout: 60_000, polling: 250 });
		console.log(`[${name}] booted (session UI ready)`);
		return { name, browser, page };
	}

	// Select the pinned map on BOTH pages so the room and the client agree.
	const host = await boot('AlphaCmd', '');
	await host.page.selectOption('#session-map', mapUid);
	clients.push(host);
	const joiner = await boot('BravoCmd', '');
	await joiner.page.selectOption('#session-map', mapUid);
	clients.push(joiner);

	// A opens the Multiplayer tab and hosts through the real button; capture the
	// room from the roomhost log.
await host.page.waitForFunction(() => (document.getElementById('session-map')?.options?.length ?? 0) > 0, undefined, { timeout: 60_000, polling: 250 });
	await host.page.click('#session-tab-mp');
	await host.page.waitForSelector('#session-mp-name', { state: 'visible', timeout: 30_000 });
	// The host POST requires a nickname (T1.10): type it in the real field.
	await host.page.fill('#session-mp-name', 'AlphaCmd');
	// The keyed validator caps slots at the pinned map's seat count (2);
	// the dropdown defaults to 8, which the node rightly rejects.
	await host.page.selectOption('#session-mp-slots', '2');
	await host.page.click('#session-mp-host');
	const roomDeadline = Date.now() + 30_000;
	let room;
	while (Date.now() < roomDeadline) {
		room = roomhostLog.reverse().find(l => /room \S+ created/.test(l));
		roomhostLog.reverse();
		if (room) break;
		await new Promise(r => setTimeout(r, 500));
	}
	if (!room) throw new Error('room host never created a room');
	const roomId = /room (\S+) created/.exec(room)[1];
	console.log(`room ${roomId} created by the UI host flow`);

	// B opens the Multiplayer tab, waits for the room browser to list the room,
	// and clicks the row's Join button (real UI path, no endpoint typing).
await joiner.page.waitForFunction(() => (document.getElementById('session-map')?.options?.length ?? 0) > 0, undefined, { timeout: 60_000, polling: 250 });
	await joiner.page.click('#session-tab-mp');
	await joiner.page.waitForFunction(
		() => document.querySelectorAll('#session-mp-rooms-body button').length > 0,
		{ timeout: 30_000 },
	);
	await joiner.page.fill('#session-mp-name', 'BravoCmd');
	await joiner.page.click('#session-mp-rooms-body button');
	await sleep(1500);
	const joinDiag = await joiner.page.evaluate(async () => ({
		status: document.getElementById('session-status')?.textContent ?? '',
		mpStatus: document.getElementById('session-mp-status')?.textContent ?? '',
		probe: globalThis.ora.GetConnectionProbe(),
		close: await globalThis.steelseedBridge.getMpCloseInfo(),
	}));
	console.log(`[BravoCmd] join click: ${JSON.stringify(joinDiag)}`);

	async function waitBoth(re, timeoutMs, label) {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const probes = await Promise.all(clients.map(c => c.page.evaluate(() => globalThis.ora.GetConnectionProbe())));
			if (probes.every(p => re.test(p))) { console.log(`OK ${label}`); return probes; }
			if (Date.now() > end) throw new Error(`TIMEOUT ${label}\n  A: ${probes[0]}\n  B: ${probes[1]}`);
			await new Promise(r => setTimeout(r, 1000));
		}
	}

	await waitBoth(/state=Connected/, 60_000, 'BOTH CONNECTED via UI flow');
	// L8: nobody auto-readies — both players press the lobby's Ready button,
	// then the admin presses Start match. All real UI clicks, no exports.
	for (const c of clients) await waitInLobby(c, 2);
	for (const c of clients) await clickReady(c);
	await clickAdminStart(host);
	await waitBoth(/started=True/, 240_000, 'game started on both');

	const deadline = Date.now() + 300_000;
	let last = await Promise.all(clients.map(c => c.page.evaluate(() => globalThis.ora.GetConnectionProbe())));
	for (;;) {
		last = await Promise.all(clients.map(c => c.page.evaluate(() => globalThis.ora.GetConnectionProbe())));
		if (last.some(p => field(p, 'outofsync') === 'True')) throw new Error(`DESYNC: ${last[0]} | ${last[1]}`);
		if (last.every(p => Number(field(p, 'netframe')) > TARGET_FRAMES)) break;
		if (Date.now() > deadline) throw new Error(`frame budget timeout: ${last[0]} | ${last[1]}`);
		await new Promise(r => setTimeout(r, 2000));
	}

	const frames = last.map(p => Number(field(p, 'netframe')));
	const oos = last.map(p => field(p, 'outofsync'));
	result = frames.every(f => f > TARGET_FRAMES) && oos.every(v => v === 'False') ? 'MILESTONE PASS' : 'MILESTONE INCOMPLETE';
	console.log(`=== RESULT: A frame=${frames[0]} B frame=${frames[1]} outofsync=${oos.join('/')} ===`);
} catch (e) {
	console.error('FAILED:', e.message);
	console.error(`--- roomhost tail ---\n${roomhostLog.slice(-15).join('\n')}`);
} finally {
	for (const c of clients) await c.browser.close().catch(() => {});
	// SIGTERM first: roomhost's shutdown kills its room dedicated groups, so no
	// detached server holds the stdio pipe (and this shell) open.
	roomhost.kill('SIGTERM');
	await new Promise(r => setTimeout(r, 1500));
	try { process.kill(-roomhost.pid, 'SIGKILL'); } catch { /* roomhost gone */ }
	fs.rmSync(dataDir, { recursive: true, force: true });
}
await new Promise(r => setTimeout(r, 1000));
console.log(result);
process.exitCode = result === 'MILESTONE PASS' ? 0 : 1;
