// Ranked E2E release gate.
//
// This is intentionally a real-system gate: local spine + owner roomhost +
// native dedicated server + two separately hosted browser/WASM clients.  It
// reserves through /v2/ranked/provision, finalizes signed HMAC claims, consumes
// each participant claim once, plays a two-human match, submits a real engine
// Surrender order, retains the server .orarep, and verifies it with the native
// same-engine RankedReplayVerifier.
//
// The effective lobby rules hash cannot be guessed safely before a release.
// A bootstrap match first records the exact current lobby and the verifier's
// explicit --inspect mode derives its canonical hash.  The second match is the
// actual fail-closed Ranked proof and must produce a signed settled receipt.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadChromium, launchGpuBrowser } from '../../../web/tools/harness.mjs';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { canonicalJson, hostKeyHash, signClaim } from '../../steelseed-host/tools/ranked-claims.mjs';

const execFileAsync = promisify(execFile);
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(testsDir, '../..');
const staticScript = path.join(testsDir, 'server.mjs');
const spineScript = path.join(engineRoot, 'steelseed-host/tools/spine.mjs');
const roomhostScript = path.join(engineRoot, 'steelseed-host/tools/roomhost.mjs');
const rankedWorkerScript = path.join(engineRoot, 'steelseed-host/tools/ranked-worker.mjs');
const bundleRoot = path.join(engineRoot, 'bin-browser/AppBundle');
const verifier = path.join(engineRoot, 'openra/bin/ranked-replay-verifier', process.platform === 'win32' ? 'Steelseed.RankedReplayVerifier.exe' : 'Steelseed.RankedReplayVerifier');
const gateMap = JSON.parse(fs.readFileSync(path.join(engineRoot, 'steelseed-host/generated/mods/ra/gate-map.json'), 'utf8'));
const build = JSON.parse(fs.readFileSync(path.join(engineRoot, 'steelseed-host/generated/build.json'), 'utf8'));
const dotnetRoot = process.env.DOTNET_ROOT || path.join(os.homedir(), '.dotnet');
const bootstrapHash = '0'.repeat(64);
const claimSecret = crypto.randomBytes(32).toString('base64url');
const provisionToken = crypto.randomBytes(32).toString('base64url');
const ownerToken = crypto.randomBytes(32).toString('base64url');
const receiptKeys = crypto.generateKeyPairSync('ed25519');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!/^[0-9a-f]{40}$/.test(gateMap.uid ?? '')) throw new Error('ranked gate map is not generated');
if (!/^[0-9a-f]{12}$/.test(build.simBuild ?? '')) throw new Error('ranked gate sim build is not generated');
for (const required of [bundleRoot, spineScript, roomhostScript, verifier])
	if (!fs.existsSync(required)) throw new Error(`ranked gate prerequisite missing: ${required}`);

function decodeClaim(token) {
	return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8'));
}

function writeRankedPins(rulesHash) {
	const file = path.resolve(engineRoot, '../deploy/vps/ranked-pins.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const bytes = `${JSON.stringify({ schema: 1, simBuild: build.simBuild, mapUid: gateMap.uid, rulesHash })}\n`;
	// A verification rerun against UI-only AppBundle changes must not create a
	// misleadingly fresh release candidate when the canonical values did not
	// move. The first write or any real pin change still uses fsync + rename.
	if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === bytes) return file;
	const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
	const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
	try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	fs.renameSync(temp, file);
	return file;
}

async function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(error => error ? reject(error) : resolve(port));
		});
	});
}

async function fetchJson(url, options = {}) {
	const response = await fetch(url, options);
	const text = await response.text();
	let body = text;
	try { body = JSON.parse(text); } catch { /* retain text */ }
	return { status: response.status, body };
}

async function waitFor(fn, timeoutMs, label, intervalMs = 250) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	for (;;) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (error) { lastError = error; }
		if (Date.now() > deadline)
			throw new Error(`TIMEOUT ${label}${lastError ? `: ${lastError.message}` : ''}`);
		await sleep(intervalMs);
	}
}

function attach(label, child) {
	const ring = [];
	const ingest = (chunk, stderr = false) => {
		for (const raw of String(chunk).split('\n')) {
			if (!raw.trim()) continue;
			const line = stderr ? `(err) ${raw}` : raw;
			ring.push(line);
			if (ring.length > 500) ring.shift();
			if (/registered as node|ranked|room .*created|state (reserved|lobby|playing)|player chan|notification-game-started|dedicated exited/i.test(line))
				console.log(`[${label}] ${line.slice(0, 260)}`);
		}
	};
	child.stdout?.on('data', chunk => ingest(chunk));
	child.stderr?.on('data', chunk => ingest(chunk, true));
	return ring;
}

function processEnv(extra = {}) {
	return { ...process.env, DOTNET_ROOT: dotnetRoot, ...extra };
}

async function startRig(rulesHash, label) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `redline-ranked-${label}-`));
	const nodeData = path.join(root, 'node');
	const rankedInbox = path.join(root, 'ranked-inbox');
	const rankedWorkerState = path.join(root, 'ranked-worker');
	fs.mkdirSync(nodeData, { recursive: true });
	fs.mkdirSync(rankedInbox, { recursive: true });
	const [spineHttp, spineWs, nodeHttp, nodeWs, dedicatedBase] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
	const configFile = path.join(root, 'relay.json');
	fs.writeFileSync(configFile, `${JSON.stringify({
		publicUrl: `http://127.0.0.1:${spineWs}`,
		siteOrigins: [], browserMultiplayer: 'off', placement: 'donated+owner', acceptedBuilds: [build.simBuild],
	})}\n`);
	const receiptKeyFile = path.join(root, 'ranked-receipt-private.pem');
	fs.writeFileSync(receiptKeyFile, receiptKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });

	const spine = spawnProcessGroup(process.execPath, [spineScript,
		'--http', String(spineHttp), '--ws', String(spineWs), '--config', configFile,
	], { cwd: engineRoot, stdio: ['ignore', 'pipe', 'pipe'], env: processEnv({
		STEELSEED_NODE_TOKEN: ownerToken,
		REDLINE_RANKED_CLAIM_SECRET: claimSecret,
		REDLINE_RANKED_PROVISION_TOKEN: provisionToken,
		REDLINE_RANKED_RULES_HASH: rulesHash,
	}) });
	const spineLog = attach(`${label}-spine`, spine);
	await waitFor(() => fetchJson(`http://127.0.0.1:${spineHttp}/nodes`).then(result => result.status === 200), 15_000, `${label} spine`);

	const nodeKey = crypto.randomBytes(32).toString('hex');
	const rankedWorker = rulesHash === bootstrapHash ? null : spawnProcessGroup(process.execPath, [rankedWorkerScript], {
		cwd: engineRoot, stdio: ['ignore', 'pipe', 'pipe'], env: processEnv({
			REDLINE_RANKED_INBOX: rankedInbox,
			REDLINE_RANKED_CLAIMED: path.join(root, 'ranked-claimed'),
			REDLINE_RANKED_WORKER_STATE: rankedWorkerState,
			REDLINE_RANKED_RECEIPT_PRIVATE_KEY_FILE: receiptKeyFile,
			REDLINE_RANKED_SIM_BUILD: build.simBuild,
			REDLINE_RANKED_RULES_HASH: rulesHash,
			REDLINE_RANKED_VERIFIER: verifier,
			REDLINE_ENGINE_DIR: engineRoot,
			REDLINE_RANKED_WORKER_POLL_MS: '100',
		}),
	});
	const workerLog = rankedWorker ? attach(`${label}-ranked-worker`, rankedWorker) : [];
	const roomhost = spawnProcessGroup(process.execPath, [roomhostScript,
		'--bundle', bundleRoot, '--ws', String(nodeWs), '--http', String(nodeHttp),
		'--base-port', String(dedicatedBase), '--max-matches', '1', '--idle-kill', '180',
		'--spine', `ws://127.0.0.1:${spineWs}/node`, '--data-dir', nodeData,
	], { cwd: engineRoot, stdio: ['ignore', 'pipe', 'pipe'], env: processEnv({
		REDLINE_NODE_KEY: nodeKey,
		REDLINE_NODE_TOKEN: ownerToken,
		REDLINE_RANKED_RULES_HASH: rulesHash,
		REDLINE_RANKED_CLAIM_SECRET: claimSecret,
		REDLINE_RANKED_INBOX: rankedInbox,
	}) });
	const nodeLog = attach(`${label}-node`, roomhost);
	await waitFor(async () => {
		const [listed, health] = await Promise.all([
			fetchJson(`http://127.0.0.1:${spineHttp}/nodes`),
			fetchJson(`http://127.0.0.1:${nodeHttp}/v2/health`),
		]);
		return Array.isArray(listed.body) && listed.body.length === 1 && health.body?.relay?.connected === true &&
			health.body?.build === build.simBuild && health.body?.rulesHash === rulesHash;
	}, 25_000, `${label} owner node registration`);
	return { label, root, nodeData, rankedInbox, rankedWorkerState, spineHttp, spineWs, nodeHttp, nodeWs, dedicatedBase,
		spine, roomhost, rankedWorker, spineLog, nodeLog, workerLog };
}

async function stopRig(rig, remove = true) {
	await stopProcessGroup(rig?.roomhost).catch(() => {});
	await stopProcessGroup(rig?.rankedWorker).catch(() => {});
	await stopProcessGroup(rig?.spine).catch(() => {});
	if (remove && rig?.root) fs.rmSync(rig.root, { recursive: true, force: true });
}

async function bootClient(chromium, staticPort, name) {
	const launched = await launchGpuBrowser(chromium, `mp-ranked-e2e-${name}`);
	const page = await launched.browser.newPage({ viewport: { width: 960, height: 640 } });
	const errors = [];
	page.on('pageerror', error => errors.push(String(error)));
	page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	await page.goto(`http://127.0.0.1:${staticPort}/index.html?mode=game&platform=null&debug=on&Player.Name=${encodeURIComponent(name)}`);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined' && typeof globalThis.steelseedBridge !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	console.log(`[${name}] browser/WASM ready (${launched.label})`);
	return { name, browser: launched.browser, page, errors };
}

async function probeDebugFrontend(browser, staticPort) {
	const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
	try {
		await page.goto(`http://127.0.0.1:${staticPort}/steelseed/index.html?debug=on`);
		await page.waitForFunction(() => new URLSearchParams(location.search).get('debug') === 'on' &&
			document.getElementById('session-account')?.hidden === false, undefined, { timeout: 180_000 });
		await page.click('#session-tab-mp');
		const state = await page.evaluate(() => ({
			accountVisible: document.getElementById('session-account')?.hidden === false,
			mpSelected: document.getElementById('session-tab-mp')?.getAttribute('aria-selected') === 'true',
			mpPanelVisible: document.getElementById('session-mp-panel')?.hidden === false,
			offNoticeHidden: document.getElementById('session-mp-off')?.hidden === true,
		}));
		assert.deepEqual(state, { accountVisible: true, mpSelected: true, mpPanelVisible: true, offNoticeHidden: true });
		console.log('[frontend] debug=on exposes Account and functional Multiplayer panel');
	} finally { await page.close().catch(() => {}); }
}

async function probe(client) {
	return client.page.evaluate(() => globalThis.ora.GetConnectionProbe());
}

async function allProbe(clients, pattern, timeoutMs, label) {
	return waitFor(async () => {
		const values = await Promise.all(clients.map(probe));
		return values.every(value => pattern.test(value)) ? values : null;
	}, timeoutMs, label, 500);
}

async function provisionRankedRoom(rig, rulesHash, label) {
	const provisioned = await fetchJson(`http://127.0.0.1:${rig.spineHttp}/v2/ranked/provision`, {
		method: 'POST', headers: { authorization: `Bearer ${provisionToken}`, 'content-type': 'application/json' },
		body: JSON.stringify({ mapUid: gateMap.uid, slots: 2, idempotencyKey: `ranked-e2e-${label}-${crypto.randomUUID()}` }),
	});
	assert.equal(provisioned.status, 201, `provision failed: ${JSON.stringify(provisioned.body)}`);
	const reservation = provisioned.body;
	assert.equal(reservation.simBuild, build.simBuild);
	assert.equal(reservation.rulesHash, rulesHash);

	const issuedAt = Date.now();
	const room = {
		schema: 2, kid: 'ranked-e2e', matchId: `ranked-e2e-${label}-${crypto.randomUUID()}`,
		roomId: reservation.roomId, tier: 'owner', mode: 'ranked', nodeId: reservation.nodeId,
		simBuild: reservation.simBuild, mapUid: reservation.mapUid, rulesHash: reservation.rulesHash,
		issuedAt, expiresAt: issuedAt + 90_000, nonce: crypto.randomBytes(16).toString('base64url'),
		hostKeyHash: hostKeyHash(reservation.hostKey), wsUrl: reservation.wsUrl,
	};
	const participants = [1, 2].map(seat => ({
		...room, userId: `ranked-e2e-user-${seat}`, seat, team: 0, profileVersion: 1,
		participantNonce: crypto.randomBytes(16).toString('base64url'),
	}));
	const roomClaim = signClaim(room, claimSecret);
	const participantClaims = participants.map(payload => signClaim(payload, claimSecret));
	const finalized = await fetchJson(`http://127.0.0.1:${rig.spineHttp}/v2/rooms`, {
		method: 'POST', headers: { authorization: `Bearer ${provisionToken}`, 'content-type': 'application/json' },
		body: JSON.stringify({ ranked: true, hostKey: reservation.hostKey, roomClaim, participantClaims, map: gateMap.uid, slots: 2, name: `Ranked E2E ${label}` }),
	});
	assert.equal(finalized.status, 201, `ranked finalize failed: ${JSON.stringify(finalized.body)}`);
	assert.equal(finalized.body.room.roomId, reservation.roomId);
	await waitFor(async () => {
		const status = await fetchJson(`http://127.0.0.1:${rig.nodeHttp}/status.json`);
		return status.body?.rooms?.some(entry => entry.roomId === reservation.roomId && entry.dedicatedAlive);
	}, 45_000, `${label} dedicated ready`);
	return { reservation, room, roomClaim, participants, participantClaims, wsUrl: finalized.body.room.wsUrl };
}

async function runMatch(rig, clients, rulesHash, label) {
	const admission = await provisionRankedRoom(rig, rulesHash, label);
	for (const [index, client] of clients.entries()) {
		const endpoint = new URL(admission.wsUrl);
		endpoint.searchParams.set('claim', admission.participantClaims[index]);
		const set = await client.page.evaluate(url => globalThis.ora.SetWsEndpoint(url), endpoint.toString());
		assert.match(set, /^endpoint /);
		const joined = await client.page.evaluate(port => globalThis.ora.JoinMultiplayer('127.0.0.1', port), rig.spineWs);
		assert.match(joined, /^joining /);
		// The dedicated server assigns the first empty slot during handshake.
		// Wait for each signed participant before admitting the next one so the
		// transport-observed seat is deterministic and matches its claim.
		await waitFor(async () => /state=Connected.*clients=[1-9]\d*.*clientstate=(?!none)/.test(await probe(client)), 60_000, `${label} ${client.name} lobby synced`);
	}
	await allProbe(clients, /state=Connected/, 60_000, `${label} both connected`);

	// Sequential claiming makes seat assignment explicit; the signed claims
	// bind seat/team while the node separately observes server ClientIndex.
	for (const [index, client] of clients.entries()) {
		console.log(`[${label}/${client.name}] pre-claim ${await probe(client)}`);
		const claimed = await client.page.evaluate(() => globalThis.ora.LobbyClaimPlayerSlot());
		assert.match(claimed, /claiming slot|slot Multi/, `${client.name} claim failed; browser errors=${client.errors.join(' | ')}`);
		const seated = await waitFor(async () => {
			const value = await probe(client);
			const slot = /slot=(Multi\d+)/.exec(value)?.[1];
			return slot ? { value, slot } : null;
		}, 20_000, `${label} seat ${index + 1}`);
		console.log(`[${label}/${client.name}] ${claimed}; ${seated.value}`);
		assert.equal(Number(/\d+$/.exec(seated.slot)?.[0]) + 1, index + 1, `${client.name} was assigned the wrong signed seat`);
	}
	await waitFor(async () => {
		const lobbies = await Promise.all(clients.map(client => client.page.evaluate(() => globalThis.steelseedBridge.probeLobby())));
		return lobbies.every(value => /slot:Multi0[\s\S]*team:0\|spawn:1/.test(value) &&
			/slot:Multi1[\s\S]*team:0\|spawn:2/.test(value) && !/bot:true/i.test(value));
	}, 20_000, `${label} signed seat/team layout`);

	// Exercise the same typed lobby mutation APIs exposed to a real admin.
	// Ranked server authority must ignore all three; the settled verifier also
	// independently rejects a replay whose cheats/options drifted.
	const mutationResults = await clients[0].page.evaluate(async () => Promise.all([
		globalThis.steelseedBridge.lobbySetOption('cheats', 'True'),
		globalThis.steelseedBridge.lobbySetTeam(1),
		globalThis.steelseedBridge.lobbySetSpawn(0),
		globalThis.steelseedBridge.lobbyAddBots(),
	]));
	console.log(`[${label}] rejected Ranked mutation attempts: ${mutationResults.join('; ')}`);
	await sleep(750);
	const afterMutation = await Promise.all(clients.map(client => client.page.evaluate(() => globalThis.steelseedBridge.probeLobby())));
	assert.ok(afterMutation.every(value => /slot:Multi0[\s\S]*team:0\|spawn:1/.test(value) &&
		/slot:Multi1[\s\S]*team:0\|spawn:2/.test(value) && !/bot:true/i.test(value)), afterMutation.join('\n'));

	for (const client of clients) await client.page.evaluate(() => globalThis.ora.LobbySetReady());
	await allProbe(clients, /clientstate=Ready/, 30_000, `${label} both ready`);
	await clients[0].page.evaluate(() => globalThis.ora.LobbyStartGame());
	await allProbe(clients, /started=True/, 180_000, `${label} game started`);
	const before = (await Promise.all(clients.map(probe))).map(value => Number(/netframe=(\d+)/.exec(value)?.[1] ?? 0));
	await waitFor(async () => {
		const values = await Promise.all(clients.map(probe));
		return values.every((value, index) => Number(/netframe=(\d+)/.exec(value)?.[1] ?? 0) >= before[index] + 30 && /outofsync=False/.test(value));
	}, 90_000, `${label} lockstep before surrender`);

	const surrendered = await clients[1].page.evaluate(() => globalThis.ora.IssueOrderN('Surrender', 0, -1, -1, -1, false, '', 0, -1, -1));
	assert.match(surrendered, /^(?:issued 1\/1 \(player|ok: issued local player order)/);
	console.log(`[${label}] real Surrender order accepted: ${surrendered}`);
	await sleep(4000);
	for (const client of clients) await client.page.evaluate(() => globalThis.ora.LeaveMultiplayer()).catch(() => 'already gone');
	await allProbe(clients, /no connection|state=NotConnected|state=local/, 30_000, `${label} clients left`).catch(() => null);

	const archiveRoot = label === 'bootstrap' ? rig.rankedInbox : path.join(rig.rankedWorkerState, 'archive');
	const custodyRoot = await waitFor(() => {
		try {
			const entry = fs.readdirSync(archiveRoot, { withFileTypes: true }).find(candidate => candidate.isDirectory() && candidate.name.endsWith('.job'));
			return entry ? path.join(archiveRoot, entry.name) : null;
		} catch { return null; }
	}, 180_000, `${label} ${label === 'bootstrap' ? 'custody inbox' : 'isolated worker archive'}`);
	const job = JSON.parse(fs.readFileSync(path.join(custodyRoot, 'job.json'), 'utf8'));
	const custody = job.custody;
	assert.equal(custody.matchId, admission.room.matchId);
	assert.equal(custody.bindingError, null);
	assert.equal(custody.rankedBindings.length, 2);
	assert.ok(custody.rankedBindings.every(binding => Number.isInteger(binding.clientIndex) && Number.isInteger(binding.seat) && Number.isInteger(binding.team)));
	assert.deepEqual(custody.rankedBindings.map(binding => binding.seat).sort(), [1, 2]);
	assert.deepEqual(custody.rankedBindings.map(binding => binding.team), [0, 0]);
	const replayFile = path.join(custodyRoot, 'replay.orarep');
	assert.ok(replayFile.endsWith('.orarep') && fs.statSync(replayFile).size > 0, 'server replay was not retained');
	const receiptFile = path.join(custodyRoot, 'ranked-receipt.json');
	if (label !== 'bootstrap')
		await waitFor(() => fs.existsSync(receiptFile), 30_000, `${label} worker verifier receipt`);
	const nodeReceipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
	return { admission, custodyRoot, custody, replayFile, nodeReceipt };
}

async function inspectReplay(replayFile, supportDir) {
	let stdout;
	try {
		({ stdout } = await execFileAsync(verifier, ['--inspect', '--replay', replayFile, '--engine-dir', engineRoot, '--support-dir', supportDir], {
			cwd: engineRoot, env: processEnv(), maxBuffer: 4 * 1024 * 1024, timeout: 180_000, killSignal: 'SIGKILL',
		}));
	} catch (error) {
		throw new Error(`native replay inspection failed: ${String(error.stderr || error.stdout || error.message).trim()}`);
	}
	return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function verifyNative(match, rulesHash, supportDir) {
	const byDigest = new Map(match.custody.rankedBindings.map(binding => [binding.claimDigest, binding]));
	const participants = match.admission.participantClaims.map(token => {
		const payload = decodeClaim(token);
		const digest = crypto.createHash('sha256').update(token).digest('hex');
		const binding = byDigest.get(digest);
		assert.ok(binding, `missing server binding for claim ${digest}`);
		return { userId: payload.userId, seat: payload.seat, team: payload.team, clientIndex: binding.clientIndex };
	});
	const claim = { ...match.admission.room, participants };
	const claimFile = path.join(match.custodyRoot, 'ranked-e2e-bound-claim.json');
	fs.writeFileSync(claimFile, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
	const { stdout } = await execFileAsync(verifier, ['--replay', match.replayFile, '--claim', claimFile,
		'--engine-dir', engineRoot, '--support-dir', supportDir], {
		cwd: engineRoot, env: processEnv({ REDLINE_RANKED_RULES_HASH: rulesHash }), maxBuffer: 4 * 1024 * 1024,
		timeout: 180_000, killSignal: 'SIGKILL',
	});
	return { result: JSON.parse(stdout.trim().split('\n').at(-1)), claim };
}

let staticServer = null;
let bootstrapRig = null;
let rankedRig = null;
const clients = [];
let pass = false;
try {
	const staticPort = await freePort();
	staticServer = spawnProcessGroup(process.execPath, [staticScript, '--root', bundleRoot, '--port', String(staticPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
	attach('static', staticServer);
	await waitFor(() => new Promise(resolve => {
		const req = http.get(`http://127.0.0.1:${staticPort}/index.html`, response => { response.resume(); resolve(response.statusCode === 200); });
		req.on('error', () => resolve(false));
	}), 15_000, 'static AppBundle');
	const chromium = await loadChromium('mp-ranked-e2e');
	clients.push(await bootClient(chromium, staticPort, 'RankedAlpha'));
	clients.push(await bootClient(chromium, staticPort, 'RankedBravo'));
	await probeDebugFrontend(clients[0].browser, staticPort);

	bootstrapRig = await startRig(bootstrapHash, 'bootstrap');
	const bootstrap = await runMatch(bootstrapRig, clients, bootstrapHash, 'bootstrap');
	const inspection = await inspectReplay(bootstrap.replayFile, path.join(bootstrapRig.root, 'inspect-support'));
	assert.match(inspection.RulesHash, /^[0-9a-f]{64}$/);
	assert.equal(inspection.MapUid, gateMap.uid);
	assert.deepEqual(inspection.Clients.map(client => client.Seat).sort(), [1, 2]);
	assert.deepEqual(inspection.Clients.map(client => client.Team), [0, 0]);
	console.log(`[bootstrap] canonical effective rules hash ${inspection.RulesHash}`);
	await stopRig(bootstrapRig);
	bootstrapRig = null;

	rankedRig = await startRig(inspection.RulesHash, 'ranked');
	const ranked = await runMatch(rankedRig, clients, inspection.RulesHash, 'ranked');
	assert.equal(ranked.nodeReceipt.receipt?.status, 'settled', JSON.stringify(ranked.nodeReceipt));
	assert.equal(ranked.nodeReceipt.receipt?.terminationReason, 'surrender');
	assert.equal(ranked.nodeReceipt.receipt?.players?.length, 2);
	const signed = { ...ranked.nodeReceipt.receipt };
	const signature = signed.signature;
	delete signed.signature;
	assert.equal(crypto.verify(null, Buffer.from(canonicalJson(signed)), receiptKeys.publicKey, Buffer.from(signature, 'base64url')), true, 'node receipt signature');

	const native = await verifyNative(ranked, inspection.RulesHash, path.join(rankedRig.root, 'native-verify-support'));
	assert.equal(native.result.Status, 'settled', JSON.stringify(native.result));
	assert.equal(native.result.TerminationReason, 'surrender');
	assert.equal(native.result.Players.length, 2);
	assert.deepEqual(native.result.Players.map(player => player.ClientIndex).sort((a, b) => a - b),
		native.claim.participants.map(player => player.clientIndex).sort((a, b) => a - b));
	assert.ok(native.result.Players.some(player => player.Surrendered === true));
	assert.ok(clients.every(client => client.errors.length === 0), `browser errors: ${clients.flatMap(client => client.errors).join(' | ')}`);
	const pinFile = writeRankedPins(inspection.RulesHash);

	console.log(`RANKED E2E PASS: room=${ranked.admission.reservation.roomId} match=${ranked.admission.room.matchId}`);
	console.log(`  build=${build.simBuild} map=${gateMap.uid} rules=${inspection.RulesHash}`);
	console.log(`  replay=${path.relative(rankedRig.nodeData, ranked.replayFile)} bytes=${fs.statSync(ranked.replayFile).size}`);
	console.log(`  bindings=${JSON.stringify(ranked.custody.rankedBindings.map(({ clientIndex, seat, team }) => ({ clientIndex, seat, team })))}`);
	console.log(`  native=${native.result.Status}/${native.result.TerminationReason} tick=${native.result.FinalTick}`);
	console.log(`  pins=${pinFile}`);
	pass = true;
} catch (error) {
	console.error('RANKED E2E FAILED:', error.stack ?? error.message);
	for (const rig of [bootstrapRig, rankedRig]) {
		if (!rig) continue;
		console.error(`--- retained failure data: ${rig.root}`);
		console.error(`--- ${rig.label} spine tail ---\n${rig.spineLog.slice(-30).join('\n')}`);
		console.error(`--- ${rig.label} node tail ---\n${rig.nodeLog.slice(-40).join('\n')}`);
	}
} finally {
	for (const client of clients) await client.browser.close().catch(() => {});
	await stopRig(bootstrapRig, pass).catch(() => {});
	await stopRig(rankedRig, pass).catch(() => {});
	await stopProcessGroup(staticServer).catch(() => {});
}

process.exitCode = pass ? 0 : 1;
