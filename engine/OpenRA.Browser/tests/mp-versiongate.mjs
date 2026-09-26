// mp-versiongate (T2.9, §9.2) — version mismatch is refused end to end.
// One PASS/FAIL line per case; exit non-zero when any case fails.
//
//   GUARD    a node started with --skip-build-check and WITHOUT env
//            REDLINE_GATE=1 must REFUSE to start (the flag exists only for
//            this gate).
//   RELAY    a node on a modified mod copy (a legitimately different
//            simBuild) registering with a relay whose acceptedBuilds holds
//            the real build -> the relay closes the tunnel with 4003, the
//            close reason is the accepted-build list, the node prints the
//            machine-readable update-required line, /v2/health reports
//            closeCode 4003, and the node never retries.
//   CLIENT   a real-build client joining a room hosted on that modified mod
//            is refused by the OpenRA handshake (Server.cs: "Not running
//            the same version" -> ServerError notification-incompatible-
//            version) and the lobby shows S11 ("Different version — update
//            Redline Wars to join.") within 10 s of the Join click.
//
// The variant is legitimate, never forged: the gate assembles a packaged-node
// tree with assemble-node.mjs, appends one comment line to a rules file,
// re-stamps mod.yaml's Version with the RECOMPUTED sim build id and writes
// the matching build.json (sim-build-id.mjs algebra: A' = modTreeHash of the
// modified copy; B/C/D are the shared, untouched C# trees).
//
// T2.1 revert behaviour: the gate fails when the T2.1 stamp is reverted. If
// mod.yaml's Version stopped varying with the sim build id, the variant
// server's manifest Version would equal the real client's handshake version,
// the join in CLIENT would be ACCEPTED, and the S11 assertion would time out
// and fail (likewise RELAY: an acceptedBuilds list keyed on the shared id
// would admit the variant node, so the 4003 assertion would fail).
//
// Usage: node mp-versiongate.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { launchGpuBrowser } from '../../../web/tools/harness.mjs';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..'); // the engine tree
const toolsDir = path.join(repoRoot, 'steelseed-host/tools');
const engineRoot = repoRoot;
const bundleRoot = path.join(repoRoot, 'bin-browser/AppBundle');

const relayHttp = Number(process.env.VERSION_RELAY_HTTP ?? '13640');
const relayWs = Number(process.env.VERSION_RELAY_WS ?? '13641');
const relay2Http = Number(process.env.VERSION_RELAY2_HTTP ?? '13642');
const relay2Ws = Number(process.env.VERSION_RELAY2_WS ?? '13643');
const nodeBasePort = Number(process.env.VERSION_NODE_BASE ?? '13450');
const httpPort = Number(process.env.VERSION_HTTP ?? '8366');

const S11 = 'Different version — update Redline Wars to join.';
const RULES_TOUCH = 'rules/aircraft.yaml';

const verdicts = [];
function verdict(name, ok, detail = '') {
	verdicts.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
	return ok;
}

function attach(label, child, ring) {
	const onLine = line => {
		if (!line.trim()) return;
		ring.push(line);
		if (ring.length > 500) ring.shift();
		if (/\[\[redline-node\]\]|registered|spine tunnel|state |created|update-required|directory http|ws mux/.test(line))
			console.log(`[${label}] ${line.slice(0, 240)}`);
	};
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', d => { for (const line of String(d).split('\n')) onLine(line); });
	child.stderr?.on('data', d => { for (const line of String(d).split('\n')) if (line.trim()) ring.push(`(err) ${line}`); });
	return ring;
}

async function waitReady(fn, timeoutMs, everyMs = 250) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
		if (Date.now() > deadline) return null;
		await new Promise(r => setTimeout(r, everyMs));
	}
}

function httpJson(port, pathname, { method = 'GET', headers = {}, body = null } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString();
				resolve({ status: res.statusCode, text, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
			});
		});
		req.on('error', reject);
		req.setTimeout(5000, () => req.destroy(new Error('timeout')));
		if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
		req.end();
	});
}

// ---- 1. the real build identity, verified against the tree ----
const realBuildInfo = JSON.parse(fs.readFileSync(path.join(repoRoot, 'steelseed-host/generated/build.json'), 'utf8'));
const realBuild = realBuildInfo.simBuild;
const sim = await import(path.join(toolsDir, 'sim-build-id.mjs'));
const { modTreeHash, treeHash, computeSimBuild, MOD_VERSION_TAG } = sim;
const liveBuild = computeSimBuild(engineRoot);
if (liveBuild !== realBuild)
	console.log(`WARN generated/build.json (${realBuild}) does not match the live tree (${liveBuild}) — continuing, but the RELAY case pins acceptedBuilds to build.json`);

// B/C/D are the shared C#/yaml trees (identical for real and variant); only
// the mod copy (A) differs, so the variant id is A' + the shared B/C/D.
const sharedB = treeHash(engineRoot, ['openra/**/*.cs', 'openra/**/*.yaml']);
const sharedC = treeHash(engineRoot, ['steelseed-host/OpenRA.Mods.Steelseed/**/*.cs']);
const sharedD = treeHash(engineRoot, [
	'OpenRA.Game/**/*.cs', 'OpenRA.Mods.Common/**/*.cs', 'OpenRA.Mods.Cnc/**/*.cs',
	'OpenRA.Mods.Steelseed/**/*.cs', 'OpenRA.Server/**/*.cs',
]);
const variantSimBuildOf = modHash =>
	crypto.createHash('sha256').update(`redline-sim-v1\n${modHash}${sharedB}${sharedC}${sharedD}`).digest('hex').slice(0, 12);

// ---- 2. the variant node tree (packaged layout via assemble-node) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-versiongate-'));
const variantNodeDir = path.join(tmp, 'node');
const { assembleNode } = await import(path.join(toolsDir, 'assemble-node.mjs'));
const { resolveRid } = await import(path.join(toolsDir, 'dedicated-runner.mjs'));
await assembleNode({ rid: resolveRid(), out: variantNodeDir });

const variantModDir = path.join(variantNodeDir, 'steelseed-host/generated/mods/ra');
fs.appendFileSync(
	path.join(variantModDir, RULES_TOUCH),
	`\n# mp-versiongate variant (T2.9): this one line makes the mod copy's content id differ.\n`,
);
const variantModHash = modTreeHash(variantModDir);
const variantBuild = variantSimBuildOf(variantModHash);
if (variantBuild === realBuild) throw new Error('variant build id equals the real build id — the rules touch did not move the content id');
// Restamp exactly the way build-ra-mod.mjs stamps, then record build.json.
const manifestPath = path.join(variantModDir, 'mod.yaml');
const manifestText = fs.readFileSync(manifestPath, 'utf8');
const versionLine = /^(\t*)Version:.*$/m;
if (!versionLine.test(manifestText)) throw new Error('variant mod.yaml has no Version: line to stamp');
fs.writeFileSync(manifestPath, manifestText.replace(versionLine, `$1Version: ${MOD_VERSION_TAG}-${variantBuild}`));
fs.writeFileSync(
	path.join(variantNodeDir, 'steelseed-host/generated/build.json'),
	`${JSON.stringify({ schema: 1, simBuild: variantBuild, modHash: variantModHash }, null, '\t')}\n`,
);
const variantVersion = `${MOD_VERSION_TAG}-${variantBuild}`;
console.log(`variant build ${variantBuild} (real ${realBuild}), version ${variantVersion}`);

const gateMap = JSON.parse(fs.readFileSync(path.join(variantModDir, 'gate-map.json'), 'utf8'));
const mapUid = gateMap.uid;
if (!/^[0-9a-f]{40}$/.test(mapUid ?? '')) throw new Error('gate-map.json has no uid');

// ---- 3. GUARD: --skip-build-check without REDLINE_GATE=1 refuses ----
const { REDLINE_GATE: _stripped, ...inheritedEnv } = process.env;
const guardLog = [];
const guard = spawnProcessGroup(process.execPath, [
	path.join(variantNodeDir, 'steelseed-host/tools/node-cli.mjs'),
	'--skip-build-check', '--data-dir', path.join(tmp, 'guard-data'), '--http', '0', '--ws', '0',
], {
	stdio: ['ignore', 'pipe', 'pipe'],
	env: { ...inheritedEnv, REDLINE_NODE_KEY: crypto.randomBytes(32).toString('hex') },
});
attach('guard', guard, guardLog);
const guardCode = await new Promise(resolve => {
	const t = setTimeout(() => resolve('timeout'), 20_000);
	guard.on('exit', code => { clearTimeout(t); resolve(code); });
});
verdict('GUARD skip-build-check refused without REDLINE_GATE=1',
	guardCode !== 0 && guardCode !== 'timeout' && guardLog.some(l => l.includes('REDLINE_GATE=1')),
	`exit=${guardCode} log=${guardLog.slice(-3).join(' | ').slice(0, 300)}`);
await stopProcessGroup(guard);

// ---- 4. the real relay: acceptedBuilds = [realBuild] ----
const relayConfigPath = path.join(tmp, 'relay1.json');
fs.writeFileSync(relayConfigPath, JSON.stringify({ acceptedBuilds: [realBuild] }));
const relay = spawnProcessGroup(process.execPath, [
	path.join(toolsDir, 'spine.mjs'), '--http', String(relayHttp), '--ws', String(relayWs), '--config', relayConfigPath,
], { stdio: ['ignore', 'pipe', 'pipe'] });
const relayLog = attach('relay', relay, []);
const relayUp = await waitReady(async () => (await httpJson(relayHttp, '/v2/config')).status === 200, 15_000);
if (!relayUp) throw new Error(`relay never came up\n${relayLog.slice(-10).join('\n')}`);

// ---- 5. the variant node dials the real relay: 4003 expected ----
const variantKey = crypto.randomBytes(32).toString('hex');
const nodeLog = [];
const variantNode = spawnProcessGroup(process.execPath, [
	path.join(variantNodeDir, 'steelseed-host/tools/node-cli.mjs'),
	'--skip-build-check', '--spine', `ws://127.0.0.1:${relayWs}/node`,
	'--http', '0', '--ws', '0', '--base-port', String(nodeBasePort),
	'--data-dir', path.join(tmp, 'node-data'), '--idle-kill', '90',
	'--bundle', bundleRoot,
], {
	stdio: ['ignore', 'pipe', 'pipe'],
	env: { ...process.env, REDLINE_GATE: '1', REDLINE_NODE_KEY: variantKey },
});
attach('node', variantNode, nodeLog);

const updateRequired = await waitReady(() => {
	const line = nodeLog.find(l => l.includes('[[redline-node]]'));
	return line ? JSON.parse(line.slice(line.indexOf('{'))) : null;
}, 20_000);
const nodeApiPort = Number(/directory http:\/\/127\.0\.0\.1:(\d+)\/v2\/rooms/.exec(nodeLog.join('\n'))?.[1] ?? 0);
const nodeHealth = nodeApiPort ? await httpJson(nodeApiPort, '/v2/health').catch(() => null) : null;
const relayNodes = await httpJson(relayHttp, '/nodes').then(r => r.json()).catch(() => []);
verdict('RELAY variant build refused with 4003 + accepted builds + no retry',
	updateRequired !== null
	&& JSON.stringify(updateRequired.accepted) === JSON.stringify([realBuild])
	&& nodeHealth?.status === 200
	&& nodeHealth.json?.relay?.connected === false
	&& nodeHealth.json?.relay?.closeCode === 4003
	&& Array.isArray(relayNodes) && relayNodes.length === 0
	&& variantNode.exitCode === null,
	`updateRequired=${JSON.stringify(updateRequired)} health=${JSON.stringify(nodeHealth?.json?.relay ?? null)} nodes=${JSON.stringify(relayNodes)}`);

// ---- 6. the accepting relay: acceptedBuilds = [variantBuild] ----
const relay2ConfigPath = path.join(tmp, 'relay2.json');
fs.writeFileSync(relay2ConfigPath, JSON.stringify({ acceptedBuilds: [variantBuild] }));
const relay2 = spawnProcessGroup(process.execPath, [
	path.join(toolsDir, 'spine.mjs'), '--http', String(relay2Http), '--ws', String(relay2Ws), '--config', relay2ConfigPath,
], { stdio: ['ignore', 'pipe', 'pipe'] });
const relay2Log = attach('relay2', relay2, []);
const relay2Up = await waitReady(async () => (await httpJson(relay2Http, '/v2/config')).status === 200, 15_000);
if (!relay2Up) throw new Error(`relay2 never came up\n${relay2Log.slice(-10).join('\n')}`);

// The same variant node tree, pointed at the accepting relay.
const variantKey2 = crypto.randomBytes(32).toString('hex');
const node2Log = [];
const variantNode2 = spawnProcessGroup(process.execPath, [
	path.join(variantNodeDir, 'steelseed-host/tools/node-cli.mjs'),
	'--skip-build-check', '--spine', `ws://127.0.0.1:${relay2Ws}/node`,
	'--http', '0', '--ws', '0', '--base-port', String(nodeBasePort + 10),
	'--data-dir', path.join(tmp, 'node2-data'), '--idle-kill', '300',
	'--bundle', bundleRoot,
], {
	stdio: ['ignore', 'pipe', 'pipe'],
	env: { ...process.env, REDLINE_GATE: '1', REDLINE_NODE_KEY: variantKey2 },
});
attach('node2', variantNode2, node2Log);
const registered = await waitReady(() => node2Log.some(l => l.includes('registered as node')), 20_000);
if (!registered) throw new Error(`variant node never registered with the accepting relay\n${node2Log.slice(-10).join('\n')}`);
const node2Api = Number(/directory http:\/\/127\.0\.0\.1:(\d+)\/v2\/rooms/.exec(node2Log.join('\n'))?.[1] ?? 0);
if (!node2Api) throw new Error(`variant node API port never surfaced\n${node2Log.slice(-10).join('\n')}`);

// ---- 7. a room on the modified mod ----
const keyHeaders = { 'content-type': 'application/json', 'x-redline-node-key': variantKey2 };
const created = await httpJson(node2Api, '/v2/rooms', {
	method: 'POST', headers: keyHeaders,
	body: { map: mapUid, slots: 2, name: 'VersionGate', solo: false },
});
if (created.status !== 201) throw new Error(`room create failed: ${created.status} ${created.text.slice(0, 200)}`);
const room = created.json.room;
const wsUrl = room.wsUrl;
console.log(`room ${room.roomId} created (ws ${wsUrl}, state ${room.state})`);
const reserved = await waitReady(async () => {
	const list = await httpJson(node2Api, '/v2/rooms', { headers: keyHeaders });
	return list.json?.rooms?.some(r => r.roomId === room.roomId && r.state === 'reserved') ?? false;
}, 20_000);
if (!reserved) throw new Error('room never reached reserved within 20 s');
const muxPort = Number(new URL(wsUrl.replace(/^ws/, 'http')).port);

// ---- 8. clients: the admin matches the variant, the joiner is real ----
const staticServer = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'pipe' });
await new Promise(r => setTimeout(r, 1000));

const launched = await launchGpuBrowser(chromium, 'mp-versiongate');
const browser = launched.browser;

async function bootComposed(name, query) {
	const page = await browser.newPage();
	page.on('pageerror', e => console.error(`[${name} pageerror]`, String(e)));
	page.on('console', m => { if (/\[mp\]|WebSocket|FATAL|handshake|incompatible/i.test(m.text())) console.log(`[${name}] ${m.text().slice(0, 300)}`); });
	await page.goto(`http://127.0.0.1:${httpPort}/steelseed/index.html?mode=game&platform=null&Player.Name=${name}${query}`, { timeout: 60_000 });
	await page.waitForFunction(() => typeof globalThis.steelseed !== 'undefined' && typeof globalThis.ora !== 'undefined' && typeof globalThis.steelseedBridge !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	console.log(`[${name}] booted`);
	return page;
}

let clientOk = false;
let clientDetail = '';
try {
	// Admin: presents the VARIANT version (Host.ModVersion override), so the
	// room proves it works and only the version differs. Real build otherwise.
	const admin = await bootComposed('GateAdmin', '&Host.DevOverrides=1' + `&Host.ModVersion=${encodeURIComponent(variantVersion)}`);
	const endpoint = await admin.evaluate(url => globalThis.ora.SetWsEndpoint(url), wsUrl);
	if (!endpoint.startsWith('endpoint ')) throw new Error(`admin SetWsEndpoint failed: ${endpoint}`);
	console.log(`[admin] join:`, await admin.evaluate(({ h, p }) => globalThis.steelseedBridge.joinMultiplayer(h, p), { h: '127.0.0.1', p: muxPort }));
	const adminDeadline = Date.now() + 60_000;
	for (;;) {
		const probe = await admin.evaluate(() => globalThis.steelseedBridge.getConnectionProbe());
		if (/state=Connected/.test(probe)) break;
		if (Date.now() > adminDeadline) {
			const err = await admin.evaluate(() => globalThis.ora.GetServerErrorProbe?.() ?? 'n/a').catch(() => 'n/a');
			throw new Error(`admin never connected: ${probe} serverError=${err}`);
		}
		await new Promise(r => setTimeout(r, 1000));
	}
	await admin.evaluate(() => globalThis.steelseedBridge.lobbyClaimPlayerSlot());
	// The room is only listed to the directory in lobby state (§5.4).
	const listed = await waitReady(async () => {
		const list = await httpJson(node2Api, '/v2/rooms');
		return list.json?.rooms?.some(r => r.roomId === room.roomId && r.state === 'lobby') ?? false;
	}, 20_000);
	if (!listed) throw new Error('room never reached lobby after the admin joined');
	console.log('room-lobby (admin in)');

	// Joiner: the REAL build, driven through the real UI join flow.
	const joiner = await bootComposed('GateJoiner', '');
	const joinerDir = `http://127.0.0.1:${node2Api}`;
	await joiner.evaluate(dir => {
		window.__steelseedSelectSession && window.__steelseedSelectSession('mp');
		window.__steelseedSetMpDir && window.__steelseedSetMpDir(dir);
	}, joinerDir);
	const rowReady = await waitReady(async () =>
		await joiner.evaluate(() => {
			const join = document.querySelector('.room-join button');
			return !!join && !join.disabled;
		}), 20_000, 500);
	if (!rowReady) {
		const diag = await joiner.evaluate(async dir => {
			let fetched = 'fetch threw';
			try {
				const res = await fetch(`${dir}/v2/rooms`);
				const body = await res.json();
				fetched = `HTTP ${res.status} rooms=${JSON.stringify(body.rooms ?? body).slice(0, 200)}`;
			} catch (e) { fetched = `fetch threw ${e}`; }
			return {
				fetched,
				sessionUiHidden: document.getElementById('session-ui')?.hidden ?? 'absent',
				roomsBody: document.getElementById('session-mp-rooms-body')?.textContent?.slice(0, 160) ?? 'absent',
				mpStatus: document.getElementById('session-mp-status')?.textContent ?? 'absent',
				bodyClass: document.body.className,
			};
		}, joinerDir);
		throw new Error(`the lobby room row never rendered: ${JSON.stringify(diag)}`);
	}
	// §7 rule 7: the join requires a nickname — fill the field the lobby
	// reads before pressing Join.
	await joiner.evaluate(() => {
		const input = document.getElementById('session-mp-name');
		if (input) {
			input.value = 'GateJoiner';
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
	});
	await joiner.evaluate(() => {
		const b = globalThis.steelseedBridge;
		globalThis.__mpCalls = {};
		for (const m of ['probeConnection', 'getServerError', 'getMpCloseInfo', 'setWsEndpoint', 'joinMultiplayer', 'setPlayerName']) {
			const raw = b[m]?.bind(b);
			if (!raw) continue;
			globalThis.__mpCalls[m] = 0;
			b[m] = (...a) => { globalThis.__mpCalls[m]++; return raw(...a); };
		}
	});
	const clickAt = Date.now();
	await joiner.evaluate(() => document.querySelector('.room-join button').click());
	const s11Deadline = clickAt + 10_000;
	for (;;) {
		const status = await joiner.evaluate(() => ({
			session: document.getElementById('session-status')?.textContent ?? '',
			mp: document.getElementById('session-mp-status')?.textContent ?? '',
		}));
		const combined = `${status.session} ${status.mp}`;
		if (combined.includes('Different version')) { clientOk = true; break; }
		if (Date.now() > s11Deadline) {
			const detail = await joiner.evaluate(async () => {
				const bridge = globalThis.steelseedBridge;
				let bridgeErr = 'n/a';
				try { bridgeErr = String(await bridge.getServerError()); } catch (e) { bridgeErr = 'threw:' + String(e).slice(0, 80); }
				return {
					mp: document.getElementById('session-mp-status')?.textContent ?? '',
					session: document.getElementById('session-status')?.textContent ?? '',
					directProbe: globalThis.ora?.GetServerErrorProbe?.() ?? 'n/a',
					bridgeErr,
					calls: globalThis.__mpCalls ?? 'absent',
				};
			}).catch(e => ({ diagError: String(e).slice(0, 100) }));
			clientDetail = `S11 not shown within 10 s: ${JSON.stringify(detail)}`;
			break;
		}
		await new Promise(r => setTimeout(r, 250));
	}
	// The dedicated-log proof of the handshake refusal (Server.cs "Not
	const refusedInLog = await waitReady(async () => {
		const st = await httpJson(node2Api, '/status.json').catch(() => null);
		const roomLog = st?.json?.rooms?.find(r => r.roomId === room.roomId)?.log ?? [];
		return roomLog.some(l => l.includes('Not running the same version'));
	}, 10_000, 500);
	console.log(`[node2] dedicated log carries the version refusal: ${refusedInLog}`);
	if (!clientOk && clientDetail === '') clientDetail = 'S11 not shown';
} catch (e) {
	clientDetail = String(e?.message ?? e);
}
verdict('CLIENT real-build joiner sees S11 within 10 s', clientOk, clientDetail);

// ---- teardown ----
await browser.close().catch(() => {});
staticServer.kill();
await stopProcessGroup(variantNode2);
await stopProcessGroup(variantNode);
await stopProcessGroup(relay2);
await stopProcessGroup(relay);
fs.rmSync(tmp, { recursive: true, force: true });

const allOk = verdicts.every(v => v.ok);
console.log(`mp-versiongate ${allOk ? 'PASS' : 'FAIL'} (${verdicts.filter(v => v.ok).length}/${verdicts.length} cases)`);
process.exitCode = allOk ? 0 : 1;
