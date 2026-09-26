// Relay registration and caps (T2.5/T2.9, §9.2): boots the real spine on
// loopback and exercises the protocol 2 registration contract:
//   - 3rd node from one ipKey            -> close 4004
//   - 17th channel on one node           -> close 1013
//   - channel over its token bucket      -> close 4008
//   - no register within 5 s             -> close 4006
//   - duplicate roomId claim             -> dropped (first reporter wins)
// plus the 4002 identity replacement, 4003 build refusal, the owner tier and
// the config file lifecycle (SIGHUP reload keeps the old config on errors).
// Run: node --test relay-registration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { reservePort } from './roomhost-fixture.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const spinePath = path.join(scriptDir, 'spine.mjs');

// Plain http requests (no keep-alive): undici's pooled sockets race the
// spine's server keepAliveTimeout and surface ECONNRESET mid-test.
function httpJson(port, pathname, { method = 'GET', headers = {}, body = null } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => {
			let data = '';
			res.on('data', c => { data += c; });
			res.on('end', () => resolve({
				status: res.statusCode,
				headers: res.headers,
				body: data,
				json: () => JSON.parse(data),
			}));
		});
		req.on('error', reject);
		req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
		if (body !== null) req.write(body);
		req.end();
	});
}

// Distinct 32-byte node keys as 43-char base64url (§5.5 shape).
let keySeq = 0;
function nodeKey() {
	keySeq += 1;
	return Buffer.concat([Buffer.alloc(31, 0xa5), Buffer.from([keySeq])]).toString('base64url');
}
function nodeIdOf(key) {
	return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function registerMsg(overrides = {}) {
	return { t: 'register', proto: 2, nodeKey: nodeKey(), build: 'devbuild01', mode: 'own', name: 'fixture', maxMatches: 1, app: '0.0.0-test', ...overrides };
}

async function waitUntil(fn, ms, why) {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await Promise.resolve().then(fn).catch(() => null);
		if (value !== null) return value;
		assert.ok(Date.now() < deadline, why);
		await delay(50);
	}
}

async function waitNodes(spine, count, why) {
	return waitUntil(async () => {
		const list = await httpJson(spine.httpPort, '/nodes').then(r => r.json());
		return list.length === count ? list : null;
	}, 5000, why);
}

// Boots a spine on two reserved ports; `config` is written to a temp
// relay.json and passed via --config.
async function startSpine(t, { config = null, extraArgs = [], env = {} } = {}) {
	const httpPort = await reservePort();
	const relayWsPort = await reservePort();
	await httpPort.release();
	await relayWsPort.release();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reg-'));
	let configFile = null;
	if (config !== null) {
		configFile = path.join(tmp, 'relay.json');
		fs.writeFileSync(configFile, JSON.stringify(config));
	}
	const proc = spawnProcessGroup(process.execPath, [spinePath,
		'--http', String(httpPort.port), '--ws', String(relayWsPort.port),
		...(configFile ? ['--config', configFile] : []), ...extraArgs], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...env },
	});
	let log = '';
	proc.stdout.on('data', c => { log += c; });
	proc.stderr.on('data', c => { log += c; });
	t.after(async () => {
		try { await stopProcessGroup(proc); } catch { /* already gone */ }
		fs.rmSync(tmp, { recursive: true, force: true });
	});
	await waitUntil(async () => {
		const res = await httpJson(httpPort.port, '/v2/config');
		return res.status === 200 ? true : null;
	}, 10_000, `spine never became ready\n${log}`);
	return { httpPort: httpPort.port, relayWsPort: relayWsPort.port, proc, log: () => log, configFile, tmp };
}

// Opens a node tunnel; resolves after the upgrade. `register` (when given)
// is sent at once; the first text reply (if any) is captured — a register
// that never earns one (it was refused) rejects after 5 s, never hangs.
async function connectNode(relayWsPort, register, { bearer = null, headers = {}, autoPong = true } = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${relayWsPort}/node`, {
		headers: bearer ? { authorization: `Bearer ${bearer}`, ...headers } : headers,
		autoPong,
	});
	ws.on('error', () => { /* refused sockets surface via 'close' */ });
	const result = { ws, reply: null, closed: null };
	result.closed = new Promise(resolve => ws.on('close', (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString() })));
	result.opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	await result.opened;
	if (register !== undefined) {
		result.reply = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('no registered reply within 5 s')), 5000);
			timer.unref();
			ws.on('message', data => {
				try { clearTimeout(timer); resolve(JSON.parse(String(data))); } catch { /* not the reply */ }
			});
		});
		// A late refusal must not surface as an unhandled rejection after the
		// test ended; awaiting code still sees the rejection.
		result.reply.catch(() => { /* observed by the awaiter or nobody */ });
		ws.send(JSON.stringify(register));
	}
	return result;
}

async function connectPlayer(relayWsPort, roomId, headers = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${relayWsPort}/g/${roomId}`, { headers });
	ws.on('error', () => { /* refused sockets surface via 'close' */ });
	const result = { ws, closed: null };
	result.closed = new Promise(resolve => ws.on('close', (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString() })));
	result.opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	await result.opened;
	return result;
}

function refusedUpgrade(relayWsPort, pathname, headers = {}) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${relayWsPort}${pathname}`, { headers });
		ws.once('unexpected-response', (_request, response) => {
			response.resume();
			resolve(response.statusCode);
		});
		ws.once('open', () => {
			ws.close();
			reject(new Error(`${pathname} unexpectedly upgraded`));
		});
		ws.on('error', () => { /* an HTTP refusal may also surface as an error */ });
	});
}

async function browserPlayer(relayWsPort, pathname, origin) {
	const ws = new WebSocket(`ws://127.0.0.1:${relayWsPort}${pathname}`, { headers: { origin } });
	ws.on('error', () => { /* close code is the assertion surface */ });
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	return { ws, closed: new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))) };
}

const ROOM_A = 'aa11bb22cc33dd44';
const ROOM_B = 'bb22cc33dd44ee55';
const ROOM_C = 'cc33dd44ee55ff66';
const ROOM_D = 'dd44ee55ff660011';
const ROOM_E = 'ee55ff6600112233';
const ROOM_F = 'ff66001122334455';
const MAP_UID = 'c6a14c146c2630a23783091d5d0d96341137f4d0';

function report(rooms) {
	return { t: 'rooms', rooms };
}

test('protocol 2 registration: window, tiers, identity, build list, ipKey cap', { timeout: 40000 }, async t => {
	const tokDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reg-tok-'));
	t.after(() => fs.rmSync(tokDir, { recursive: true, force: true }));
	const ownerTokenFile = path.join(tokDir, 'owner-token');
	fs.writeFileSync(ownerTokenFile, 'owner-secret-token\n');
	const spine = await startSpine(t, {
		config: { publicUrl: 'https://play.example', acceptedBuilds: ['aaaaaaaaaaaa'], app: { latest: '1.0.0', downloadUrl: 'https://example/dl' } },
		extraArgs: ['--owner-token-file', ownerTokenFile],
	});

	// No register within 5 s -> 4006 (§5.5).
	{
		const node = await connectNode(spine.relayWsPort);
		const closed = await node.closed;
		assert.equal(closed.code, 4006, `expected 4006, got ${JSON.stringify(closed)}`);
	}

	// Protocol 1 (no proto field) without the owner token -> 4001.
	{
		const node = await connectNode(spine.relayWsPort, { t: 'register', geo: 'eu', capacity: 2 });
		const closed = await node.closed;
		assert.equal(closed.code, 4001, `expected 4001, got ${JSON.stringify(closed)}`);
	}

	// Protocol 1 with the valid owner token is still accepted (owner tier).
	{
		const node = await connectNode(spine.relayWsPort, { t: 'register', geo: 'eu', capacity: 2 }, { bearer: 'owner-secret-token' });
		const verdict = await Promise.race([node.closed.then(c => ({ closed: c })), delay(500).then(() => ({ open: true }))]);
		assert.deepEqual(verdict, { open: true }, `protocol 1 owner register was closed: ${JSON.stringify(verdict.closed ?? null)}`);
		node.ws.close();
	}

	// Unaccepted build -> 4003 with reason = comma-separated accepted builds.
	{
		const node = await connectNode(spine.relayWsPort, registerMsg({ build: 'bbbbbbbbbbbb' }));
		const closed = await node.closed;
		assert.equal(closed.code, 4003, `expected 4003, got ${JSON.stringify(closed)}`);
		assert.equal(closed.reason, 'aaaaaaaaaaaa');
	}

	// Malformed nodeKey -> 4001 (identity material rejected).
	{
		const node = await connectNode(spine.relayWsPort, registerMsg({ nodeKey: 'too-short' }));
		const closed = await node.closed;
		assert.equal(closed.code, 4001, `expected 4001, got ${JSON.stringify(closed)}`);
	}

	// A valid community register is answered with nodeId + tier + caps (§5.5).
	const keyA = nodeKey();
	{
		const node = await connectNode(spine.relayWsPort, registerMsg({ nodeKey: keyA, build: 'aaaaaaaaaaaa' }));
		const reply = await node.reply;
		assert.equal(reply.t, 'registered');
		assert.equal(reply.nodeId, nodeIdOf(keyA));
		assert.equal(reply.tier, 'community');
		assert.deepEqual(reply.caps, { channels: 16, rateBps: 65536, burst: 524288 });

		// Same identity, newer connection: the OLDER socket gets 4002, the
		// newer one is registered in its place.
		const olderClosed = node.closed;
		const newer = await connectNode(spine.relayWsPort, registerMsg({ nodeKey: keyA, build: 'aaaaaaaaaaaa' }));
		const newerReply = await newer.reply;
		assert.equal(newerReply.t, 'registered');
		assert.equal(newerReply.nodeId, nodeIdOf(keyA));
		const closed = await olderClosed;
		assert.equal(closed.code, 4002, `older socket expected 4002, got ${JSON.stringify(closed)}`);
		newer.ws.close();
	}

	// Owner tier: proto 2 + valid owner token selects tier "owner".
	{
		const node = await connectNode(spine.relayWsPort, registerMsg({ build: 'aaaaaaaaaaaa' }), { bearer: 'owner-secret-token' });
		const reply = await node.reply;
		assert.equal(reply.tier, 'owner');
		node.ws.close();
	}
	await waitNodes(spine, 0, 'nodes never drained to zero after closes');

	// IP-keyed cap (L11): two nodes per ipKey, the third gets 4004.
	{
		const first = await connectNode(spine.relayWsPort, registerMsg({ build: 'aaaaaaaaaaaa' }));
		assert.equal((await first.reply).t, 'registered');
		const second = await connectNode(spine.relayWsPort, registerMsg({ build: 'aaaaaaaaaaaa' }));
		assert.equal((await second.reply).t, 'registered');
		await waitNodes(spine, 2, 'two registered nodes never showed up');
		const third = await connectNode(spine.relayWsPort, registerMsg({ build: 'aaaaaaaaaaaa' }));
		const closed = await third.closed;
		assert.equal(closed.code, 4004, `expected 4004, got ${JSON.stringify(closed)}`);
		first.ws.close();
		second.ws.close();
	}
});

test('rooms reports: whitelist, states, cap of 4, duplicate claims, directory shapes', { timeout: 20000 }, async t => {
	const spine = await startSpine(t, {});
	const v2Rooms = () => httpJson(spine.httpPort, '/v2/rooms').then(r => r.json());
	const nodeA = await connectNode(spine.relayWsPort, registerMsg({ mode: 'own', name: 'Alice', build: 'devbuild01' }));
	assert.equal((await nodeA.reply).t, 'registered');
	const base = { hostName: 'Alice', mapUid: MAP_UID, mapTitle: 'Marigold Town', slots: 4, players: 2, locked: false };
	nodeA.ws.send(JSON.stringify(report([
		{ roomId: 'not-a-room', name: 'Invalid', ...base, state: 'lobby', createdAt: 1 },
		{ roomId: ROOM_A, name: 'Alpha', ...base, state: 'lobby', createdAt: 1788999990000 },
		{ roomId: ROOM_B, name: 'Bravo', ...base, players: 4, state: 'playing', createdAt: 1788999991000 },
		{ roomId: ROOM_C, name: 'Charlie', ...base, players: 0, state: 'booting', createdAt: 1788999992000 },
		{ roomId: ROOM_D, name: 'Delta', ...base, slots: 999, players: 999, state: 'lobby', locked: true, createdAt: 1788999993000 },
		{ roomId: ROOM_E, name: 'Echo over the cap', ...base, players: 0, state: 'lobby', createdAt: 1788999994000 },
	])));

	// At most 4 rooms per report (T1.23); only lobby/playing are listed.
	await waitUntil(async () => {
		const list = await v2Rooms();
		return list.rooms.length === 3 ? list : null;
	}, 5000, `directory never showed the lobby/playing rooms\n${spine.log()}`);
	const v2 = await v2Rooms();
	assert.equal(v2.schema, 1);
	assert.ok(Number.isFinite(v2.now));
	assert.deepEqual(v2.rooms.map(r => r.roomId).sort(), [ROOM_A, ROOM_B, ROOM_D]);
	const alpha = v2.rooms.find(r => r.roomId === ROOM_A);
	assert.deepEqual(alpha, {
		roomId: ROOM_A,
		name: 'Alpha',
		map: { uid: MAP_UID, title: 'Marigold Town' },
		slots: 4,
		players: 2,
		state: 'lobby',
		locked: false,
		build: 'devbuild01',
		hostKind: 'player',
		hostName: 'Alice',
		createdAt: 1788999990000,
		wsUrl: `ws://127.0.0.1:${spine.relayWsPort}/g/${ROOM_A}`,
	});
	assert.equal(v2.rooms.find(r => r.roomId === ROOM_B).state, 'playing');
	assert.equal(v2.rooms.find(r => r.roomId === ROOM_D).locked, true);
	assert.equal(v2.rooms.find(r => r.roomId === ROOM_D).slots, 8);
	assert.equal(v2.rooms.find(r => r.roomId === ROOM_D).players, 8);

	// A second node's duplicate roomId claim is dropped (first reporter wins).
	const nodeB = await connectNode(spine.relayWsPort, registerMsg({ mode: 'donate', name: 'Bob' }));
	assert.equal((await nodeB.reply).t, 'registered');
	nodeB.ws.send(JSON.stringify(report([
		{ roomId: ROOM_A, name: 'IMPOSTOR', hostName: 'Bob', mapUid: MAP_UID, mapTitle: 'Marigold Town', slots: 4, players: 2, state: 'lobby', locked: false, createdAt: 1 },
		{ roomId: ROOM_F, name: 'Foxtrot', hostName: 'Bob', mapUid: MAP_UID, mapTitle: 'Marigold Town', slots: 2, players: 0, state: 'lobby', locked: false, createdAt: 1788999995000 },
	])));
	await waitUntil(async () => {
		const list = await v2Rooms();
		return list.rooms.some(r => r.roomId === ROOM_F) ? list : null;
	}, 5000, `node B's own room never listed\n${spine.log()}`);
	const after = await v2Rooms();
	assert.deepEqual(after.rooms.map(r => r.roomId).sort(), [ROOM_A, ROOM_B, ROOM_D, ROOM_F]);
	assert.equal(after.rooms.find(r => r.roomId === ROOM_A).name, 'Alpha', 'duplicate claim must not overwrite');
	assert.equal(after.rooms.find(r => r.roomId === ROOM_F).hostKind, 'donated');

	// Legacy GET /rooms: bare endpoint-free rows, geo always empty.
	const legacy = await httpJson(spine.httpPort, '/rooms').then(r => r.json());
	assert.equal(legacy.length, 4);
	for (const row of legacy) {
		assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'geo', 'map', 'name', 'players', 'roomId', 'slots']);
		assert.equal(row.geo, '');
	}
	// Legacy POST /rooms is a machine-readable 410 (§5.2).
	const legacyPost = await httpJson(spine.httpPort, '/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ map: 'c'.repeat(40) }),
	});
	assert.equal(legacyPost.status, 410);
	assert.deepEqual(legacyPost.json(), { error: 'upgrade' });

	// Placement POST with the default config: 415 on wrong content-type,
	// then 403 because a public placement request must carry an Origin (T6.4).
	const wrongType = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
	});
	assert.equal(wrongType.status, 415);
	const placement = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ map: 'c'.repeat(40) }),
	});
	assert.equal(placement.status, 403);
	assert.deepEqual(placement.json(), { error: 'origin-not-allowed' });
});

test('channel caps and per-channel token bucket', { timeout: 20000 }, async t => {
	const spine = await startSpine(t, { extraArgs: ['--trust-proxy'] });
	const opens = [];
	const node = await connectNode(spine.relayWsPort, registerMsg({ maxMatches: 1 }));
	assert.equal((await node.reply).t, 'registered');
	// Collect open notices from the first accepted channel on.
	node.ws.on('message', data => {
		try {
			const msg = JSON.parse(String(data));
			if (msg.t === 'open') opens.push(msg);
		} catch { /* not text */ }
	});
	node.ws.send(JSON.stringify(report([
		{ roomId: ROOM_A, name: 'Cap', hostName: 'Carol', mapUid: MAP_UID, mapTitle: 'M', slots: 8, players: 0, state: 'lobby', locked: false, createdAt: 1 },
	])));
	await waitUntil(async () => {
		const list = await httpJson(spine.httpPort, '/v2/rooms').then(r => r.json());
		return list.rooms.some(r => r.roomId === ROOM_A) ? list : null;
	}, 5000, `room never listed\n${spine.log()}`);

	// 8 player sockets from ONE ipKey are fine, the 9th gets 4429 (§5.6).
	const sameIp = [];
	for (let i = 0; i < 8; i++) sameIp.push(await connectPlayer(spine.relayWsPort, ROOM_A, { 'x-forwarded-for': '10.1.1.1' }));
	const ninth = await connectPlayer(spine.relayWsPort, ROOM_A, { 'x-forwarded-for': '10.1.1.1' });
	const ninthClosed = await ninth.closed;
	assert.equal(ninthClosed.code, 4429, `expected 4429, got ${JSON.stringify(ninthClosed)}`);

	// Distinct ipKeys fill the node's 16 channels; the 17th gets 1013.
	for (let i = 0; i < 8; i++) await connectPlayer(spine.relayWsPort, ROOM_A, { 'x-forwarded-for': `10.0.0.${i + 1}` });
	const seventeenth = await connectPlayer(spine.relayWsPort, ROOM_A, { 'x-forwarded-for': '10.0.0.200' });
	const seventeenthClosed = await seventeenth.closed;
	assert.equal(seventeenthClosed.code, 1013, `expected 1013, got ${JSON.stringify(seventeenthClosed)}`);

	await waitUntil(() => (opens.length >= 16 ? true : null), 5000,
		`node never saw 16 open notices, got ${opens.length}\n${spine.log()}`);
	assert.equal(opens.length, 16);

	// Blasting past the token bucket (64 KB/s, 512 KB burst) closes exactly
	// that channel with 4008; its slot frees up for a fresh channel, which
	// then keeps flowing under its own budget.
	sameIp[0].ws.send(Buffer.alloc(200_000, 1));
	sameIp[0].ws.send(Buffer.alloc(200_000, 2));
	sameIp[0].ws.send(Buffer.alloc(200_000, 3));
	sameIp[0].ws.send(Buffer.alloc(200_000, 4));
	assert.equal((await sameIp[0].closed).code, 4008, 'channel over its bucket must close 4008');
	const survivor = await connectPlayer(spine.relayWsPort, ROOM_A, { 'x-forwarded-for': '10.2.2.2' });
	survivor.ws.send(Buffer.from([1]));
	const survivorLives = await Promise.race([survivor.closed.then(() => false), delay(300).then(() => true)]);
	assert.equal(survivorLives, true, 'an in-budget channel must not be closed');
});

test('WebSocket origins enforce node/browser boundaries and the private debug rollout', {
	timeout: 30000,
	skip: process.platform === 'win32' ? 'SIGHUP config reload is a POSIX service contract' : false,
}, async t => {
	const siteOrigin = 'https://www.example';
	const spine = await startSpine(t, { config: {
		publicUrl: 'https://play.example', siteOrigins: [siteOrigin],
		browserMultiplayer: 'off', debugMultiplayer: true,
	} });

	// Legitimate node clients are native and send no Origin. A browser page
	// cannot consume the open-registration budget through /node.
	assert.equal(await refusedUpgrade(spine.relayWsPort, '/node', { origin: siteOrigin }), 403);

	const node = await connectNode(spine.relayWsPort, registerMsg());
	t.after(() => node.ws.close());
	assert.equal((await node.reply).t, 'registered');
	node.ws.send(JSON.stringify(report([{
		roomId: ROOM_A, name: 'Origin policy', hostName: 'Node', mapUid: MAP_UID,
		mapTitle: 'M', slots: 2, players: 0, state: 'lobby', locked: false, createdAt: 1,
	}])));
	await waitUntil(async () => {
		const list = await httpJson(spine.httpPort, '/v2/rooms').then(r => r.json());
		return list.rooms.some(room => room.roomId === ROOM_A) ? true : null;
	}, 5000, 'origin-policy fixture room never appeared');

	const off = await browserPlayer(spine.relayWsPort, `/g/${ROOM_A}`, siteOrigin);
	assert.equal((await off.closed).code, 4403, 'allowlisted site must still obey browserMultiplayer=off');
	const foreign = await browserPlayer(spine.relayWsPort, `/g/${ROOM_A}?debug=on`, 'https://evil.example');
	assert.equal((await foreign.closed).code, 4403, 'debug flag must not admit a foreign Origin');

	const debug = await browserPlayer(spine.relayWsPort, `/g/${ROOM_A}?debug=on`, siteOrigin);
	debug.ws.close();
	await debug.closed; // reaching OPEN already proved admission
	const loopback = await browserPlayer(spine.relayWsPort, `/g/${ROOM_A}`, 'http://127.0.0.1:18077');
	loopback.ws.close();
	await loopback.closed;
	const native = await connectPlayer(spine.relayWsPort, ROOM_A);
	native.ws.close();
	await native.closed;

	fs.writeFileSync(spine.configFile, JSON.stringify({
		publicUrl: 'https://play.example', siteOrigins: [siteOrigin], browserMultiplayer: 'join',
	}));
	process.kill(spine.proc.pid, 'SIGHUP');
	await waitUntil(async () => (await httpJson(spine.httpPort, '/v2/config').then(r => r.json())).browserMultiplayer === 'join' ? true : null,
		5000, 'join config never applied');
	const joined = await browserPlayer(spine.relayWsPort, `/g/${ROOM_A}`, siteOrigin);
	joined.ws.close();
	await joined.closed;
});

test('config lifecycle: refuse on invalid start, keep old on invalid reload, CORS, drain', {
	timeout: 30000,
	// SIGHUP reload and graceful SIGTERM drain are POSIX service contracts.
	// Windows maps these signals to forced termination (or reports ENOSYS), so
	// exercising them there cannot validate the behavior and is misleading.
	skip: process.platform === 'win32' ? 'POSIX signal lifecycle' : false,
}, async t => {
	// An invalid config file refuses startup.
	{
		const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reg-bad-'));
		t.after(() => fs.rmSync(badDir, { recursive: true, force: true }));
		const bad = path.join(badDir, 'relay.json');
		fs.writeFileSync(bad, '{ "placement": "nonsense" }');
		const httpPort = await reservePort();
		const relayWsPort = await reservePort();
		await httpPort.release();
		await relayWsPort.release();
		const proc = spawnProcessGroup(process.execPath, [spinePath,
			'--http', String(httpPort.port), '--ws', String(relayWsPort.port), '--config', bad],
			{ stdio: ['ignore', 'pipe', 'pipe'] });
		let err = '';
		proc.stderr.on('data', c => { err += c; });
		const exit = await new Promise(resolve => proc.on('exit', (code, signal) => resolve({ code, signal })));
		assert.notEqual(exit.code, 0, `invalid config must refuse startup (exit ${JSON.stringify(exit)})\n${err}`);
	}

	const spine = await startSpine(t, {
		config: {
			publicUrl: 'https://play.example',
			siteOrigins: ['https://www.example'],
			browserMultiplayer: 'off',
			placement: 'off',
			acceptedBuilds: ['cccccccccccc'],
			app: { latest: '1.2.3', downloadUrl: 'https://example/dl' },
		},
	});
	const cfg = () => httpJson(spine.httpPort, '/v2/config').then(r => r.json());
	let config = await cfg();
	assert.deepEqual(config, {
		schema: 1,
		acceptedBuilds: ['cccccccccccc'],
		browserMultiplayer: 'off',
		placement: 'off',
		capacity: { donatedFree: 0, ownerFree: 0, rankedOwnerFree: 0 },
		draining: false,
		app: { latest: '1.2.3', downloadUrl: 'https://example/dl' },
	});

	// CORS (§5.2): foreign origin gets nothing, site and loopback get echoes.
	const corsOf = async origin => httpJson(spine.httpPort, '/v2/config', { headers: { origin } })
		.then(r => r.headers['access-control-allow-origin'] ?? null);
	assert.equal(await corsOf('https://foreign.example'), null);
	assert.equal(await corsOf('https://www.example'), 'https://www.example');
	assert.equal(await corsOf('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');

	// A site origin with the browser switch off is refused before placement.
	const siteOriginPost = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.example' }, body: '{}',
	});
	assert.equal(siteOriginPost.status, 403);
	assert.deepEqual(siteOriginPost.json(), { error: 'browser-multiplayer-off' });
	const headerlessPost = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
	});
	assert.equal(headerlessPost.status, 403);
	assert.deepEqual(headerlessPost.json(), { error: 'origin-not-allowed' });

	// The private rollout is explicit in relay config and requires the obscure
	// query flag. It never changes the public browserMultiplayer value.
	fs.writeFileSync(spine.configFile, JSON.stringify({
		publicUrl: 'https://play.example',
		siteOrigins: ['https://www.example'],
		browserMultiplayer: 'off',
		debugMultiplayer: true,
		placement: 'donated',
		acceptedBuilds: ['cccccccccccc'],
	}));
	process.kill(spine.proc.pid, 'SIGHUP');
	await waitUntil(async () => (await cfg()).placement === 'donated' ? true : null, 5000, 'debug config never applied');
	const privateDebugPost = await httpJson(spine.httpPort, '/v2/rooms?debug=on', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.example' }, body: '{}',
	});
	assert.equal(privateDebugPost.status, 400, 'debug gate must reach body validation while public mode remains off');
	assert.deepEqual(privateDebugPost.json(), { error: 'invalid', field: 'map-or-slots' });
	assert.equal((await cfg()).browserMultiplayer, 'off');
	fs.writeFileSync(spine.configFile, JSON.stringify({
		publicUrl: 'https://play.example',
		siteOrigins: ['https://www.example'],
		browserMultiplayer: 'off',
		placement: 'off',
		acceptedBuilds: ['cccccccccccc'],
		app: { latest: '1.2.3', downloadUrl: 'https://example/dl' },
	}));
	process.kill(spine.proc.pid, 'SIGHUP');
	await waitUntil(async () => (await cfg()).placement === 'off' ? true : null, 5000, 'original off config never restored');

	// Invalid reload: the old configuration survives a SIGHUP.
	fs.writeFileSync(spine.configFile, '{ "publicUrl": broken');
	process.kill(spine.proc.pid, 'SIGHUP');
	await delay(300);
	config = await cfg();
	assert.equal(config.placement, 'off');
	assert.deepEqual(config.acceptedBuilds, ['cccccccccccc']);
	assert.equal('publicUrl' in config, false, 'publicUrl is config-internal, never exposed');

	// Valid reload: values change without a restart.
	fs.writeFileSync(spine.configFile, JSON.stringify({
		publicUrl: 'https://play2.example',
		siteOrigins: ['https://www.example'],
		browserMultiplayer: 'join',
		placement: 'donated',
		acceptedBuilds: ['dddddddddddd'],
		app: { latest: '1.3.0', downloadUrl: 'https://example/dl2' },
	}));
	process.kill(spine.proc.pid, 'SIGHUP');
	await waitUntil(async () => {
		const c = await cfg();
		return c.placement === 'donated' ? c : null;
	}, 5000, 'reloaded config never applied');
	config = await cfg();
	assert.equal(config.browserMultiplayer, 'join');
	assert.deepEqual(config.acceptedBuilds, ['dddddddddddd']);

	// Placement opted in but the create path lands in Phase 6 (T6.1): the
	// honest answer is no-capacity, never a room.
	const placementPost = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:18077' }, body: JSON.stringify({ map: 'c'.repeat(40) }),
	});
	assert.equal(placementPost.status, 503);
	assert.deepEqual(placementPost.json(), { error: 'no-capacity' });

	// Drain (§10.4): hold one channel open so the drain has something to wait
	// for; new nodes get 4005, new rooms 503, and once the channel closes the
	// relay exits by itself. The fixture node ships the reloaded build id.
	const node = await connectNode(spine.relayWsPort, registerMsg({ build: 'dddddddddddd' }));
	assert.equal((await node.reply).t, 'registered');
	node.ws.send(JSON.stringify(report([
		{ roomId: ROOM_A, name: 'Drain', hostName: 'Dora', mapUid: MAP_UID, mapTitle: 'M', slots: 2, players: 0, state: 'lobby', locked: false, createdAt: 1 },
	])));
	await waitUntil(async () => {
		const list = await httpJson(spine.httpPort, '/v2/rooms').then(r => r.json());
		return list.rooms.some(r => r.roomId === ROOM_A) ? list : null;
	}, 5000, `drain fixture room never listed\n${spine.log()}`);
	const player = await connectPlayer(spine.relayWsPort, ROOM_A);
	process.kill(spine.proc.pid, 'SIGTERM');
	await waitUntil(async () => {
		const c = await cfg().catch(() => null);
		return c?.draining === true ? c : null;
	}, 5000, 'relay never reported draining');
	const drainingNode = await connectNode(spine.relayWsPort, registerMsg());
	const nodeClosed = await drainingNode.closed;
	assert.equal(nodeClosed.code, 4005, `draining must refuse nodes with 4005, got ${JSON.stringify(nodeClosed)}`);
	const drainingPost = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:18077' }, body: JSON.stringify({}),
	});
	assert.equal(drainingPost.status, 503);
	assert.deepEqual(drainingPost.json(), { error: 'draining' });

	// Closing the last channel ends the drain with a clean exit.
	node.ws.close();
	player.ws.close();
	const exited = await Promise.race([
		new Promise(resolve => spine.proc.once('exit', code => resolve(code))),
		delay(5000).then(() => 'timeout'),
	]);
	assert.equal(exited, 0, `drained relay must exit 0, got ${JSON.stringify(exited)}`);
});

test('liveness tolerates one missed beat and still drops a silent socket', { timeout: 20000 }, async t => {
	const beatMs = 400;
	const spine = await startSpine(t, { extraArgs: ['--ping-interval-ms', String(beatMs)] });
	// autoPong is off, so each tunnel answers its pings on its own schedule.
	const answer = (conn, delayFor) => {
		let pings = 0;
		conn.ws.on('ping', data => {
			const wait = delayFor(pings++);
			if (wait === null) return;
			setTimeout(() => { if (conn.ws.readyState === WebSocket.OPEN) conn.ws.pong(data); }, wait).unref();
		});
	};
	// The connect-time ping is still in flight when the shared beat fires (a join
	// that lands within one RTT of a beat), and every later pong misses one beat.
	// Neither may drop the tunnel: only missedPongLimit consecutive misses do.
	const slow = await connectNode(spine.relayWsPort, registerMsg(), { autoPong: false });
	answer(slow, n => n === 0 ? beatMs * 0.9 : beatMs * 1.5);
	// A tunnel that never answers is still dropped.
	const silent = await connectNode(spine.relayWsPort, registerMsg(), { autoPong: false });
	answer(silent, () => null);
	await Promise.all([slow.reply, silent.reply]);
	let silentDropped = false;
	silent.closed.then(() => { silentDropped = true; });

	await delay(beatMs * 6);
	assert.equal(silentDropped, true, `a tunnel that never answers pings must be dropped\n${spine.log()}`);
	assert.equal(slow.ws.readyState, WebSocket.OPEN, `one missed beat must not drop the tunnel\n${spine.log()}`);
	slow.ws.close();
});

test('anonymous tunnels are capped per ipKey and cannot lock other nodes out', { timeout: 20000 }, async t => {
	const { maxPendingNodesPerIp } = JSON.parse(fs.readFileSync(path.join(scriptDir, 'protocol.json'), 'utf8')).limits;
	const spine = await startSpine(t, { extraArgs: ['--trust-proxy'] });
	// Tunnels that upgrade and never register, all from one client IP.
	const flooder = { 'x-forwarded-for': '203.0.113.9' };
	const pending = [];
	for (let i = 0; i < maxPendingNodesPerIp; i++) pending.push(await connectNode(spine.relayWsPort, undefined, { headers: flooder }));
	t.after(() => { for (const tunnel of pending) tunnel.ws.close(); });
	const refused = await connectNode(spine.relayWsPort, undefined, { headers: flooder });
	assert.equal((await refused.closed).code, 4004, 'a further anonymous tunnel from the same ipKey must be refused');
	// A node from another IP still registers while those anonymous tunnels hold their slots.
	const real = await connectNode(spine.relayWsPort, registerMsg(), { headers: { 'x-forwarded-for': '198.51.100.7' } });
	assert.equal((await real.reply).t, 'registered', spine.log());
	real.ws.close();
});

test('a reconnecting node keeps its rooms and new players when its replaced tunnel closes', { timeout: 20000 }, async t => {
	const spine = await startSpine(t, {});
	const key = nodeKey();
	const room = { roomId: ROOM_F, name: 'Rejoin', hostName: 'Rita', mapUid: MAP_UID, mapTitle: 'M', slots: 2, players: 0, state: 'lobby', locked: false, createdAt: 1 };
	const older = await connectNode(spine.relayWsPort, registerMsg({ nodeKey: key }));
	assert.equal((await older.reply).t, 'registered');
	older.ws.send(JSON.stringify(report([room])));
	t.after(() => older.ws.terminate());
	// The replaced tunnel cannot answer the relay's 4002 close frame, so its
	// teardown runs only when the relay terminates it about a second later —
	// after the newer tunnel has re-reported the room and taken a player.
	older.ws._socket.pause();
	const newer = await connectNode(spine.relayWsPort, registerMsg({ nodeKey: key }));
	assert.equal((await newer.reply).t, 'registered');
	const opened = [];
	newer.ws.on('message', data => {
		try { const msg = JSON.parse(String(data)); if (msg.t === 'open') opened.push(msg.chanId); } catch { /* binary frame */ }
	});
	newer.ws.send(JSON.stringify(report([room])));
	const player = await connectPlayer(spine.relayWsPort, ROOM_F);
	let playerClosed = null;
	player.closed.then(closed => { playerClosed = closed; });
	await waitUntil(async () => (opened.length === 1 ? true : null), 5000, `player channel never opened on the newer tunnel\n${spine.log()}`);
	// Before its teardown the replaced tunnel still sends: a channel close, a
	// data frame and an empty rooms report. None of it may reach the newer
	// tunnel's player or rooms (the paused socket can still write).
	older.ws.send(JSON.stringify({ t: 'close', chanId: opened[0] }));
	older.ws.send(Buffer.from([opened[0] >> 8, opened[0] & 0xff, 1, 2, 3]));
	older.ws.send(JSON.stringify(report([])));
	await delay(1800);
	assert.equal(playerClosed, null, `a player on the newer tunnel was dropped: ${JSON.stringify(playerClosed)}\n${spine.log()}`);
	const rejoin = await connectPlayer(spine.relayWsPort, ROOM_F);
	await waitUntil(async () => (opened.length === 2 ? true : null), 5000, `the room lost its owner when the replaced tunnel closed\n${spine.log()}`);
	player.ws.close();
	rejoin.ws.close();
	newer.ws.close();
});

test('a config reload closes nodes whose build is no longer accepted', {
	timeout: 20000,
	skip: process.platform === 'win32' ? 'SIGHUP config reload is a POSIX service contract' : false,
}, async t => {
	const spine = await startSpine(t, { config: { acceptedBuilds: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'] } });
	const retired = await connectNode(spine.relayWsPort, registerMsg({ build: 'aaaaaaaaaaaa' }));
	assert.equal((await retired.reply).t, 'registered');
	const current = await connectNode(spine.relayWsPort, registerMsg({ build: 'bbbbbbbbbbbb' }));
	assert.equal((await current.reply).t, 'registered');
	let currentClosed = null;
	current.closed.then(closed => { currentClosed = closed; });
	fs.writeFileSync(spine.configFile, JSON.stringify({ acceptedBuilds: ['bbbbbbbbbbbb'] }));
	process.kill(spine.proc.pid, 'SIGHUP');
	const closed = await retired.closed;
	assert.equal(closed.code, 4003, `retired build expected 4003, got ${JSON.stringify(closed)}\n${spine.log()}`);
	await delay(300);
	assert.equal(currentClosed, null, 'a node on an accepted build must stay connected');
	current.ws.close();
});

test('a node at the per-IP cap can reconnect and replace its own tunnel', { timeout: 20000 }, async t => {
	const spine = await startSpine(t, {});
	const key = nodeKey();
	const first = await connectNode(spine.relayWsPort, registerMsg({ nodeKey: key }));
	assert.equal((await first.reply).t, 'registered');
	const second = await connectNode(spine.relayWsPort, registerMsg());
	assert.equal((await second.reply).t, 'registered');
	t.after(() => { first.ws.terminate(); second.ws.close(); });
	// Two nodes from this ipKey fill the cap; the first reconnects with its own key.
	const again = await connectNode(spine.relayWsPort, registerMsg({ nodeKey: key }));
	assert.equal((await again.reply).t, 'registered', `a reconnect at the cap must replace its own tunnel\n${spine.log()}`);
	assert.equal((await first.closed).code, 4002);
	// A third identity from the same ipKey is still refused.
	const third = await connectNode(spine.relayWsPort, registerMsg());
	assert.equal((await third.closed).code, 4004);
	again.ws.close();
});

test('a full relay refuses a new node but lets a node replace its own tunnel', { timeout: 90000 }, async t => {
	const { maxNodes } = JSON.parse(fs.readFileSync(path.join(scriptDir, 'protocol.json'), 'utf8')).limits;
	const tokDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-full-tok-'));
	t.after(() => fs.rmSync(tokDir, { recursive: true, force: true }));
	const ownerTokenFile = path.join(tokDir, 'owner-token');
	fs.writeFileSync(ownerTokenFile, 'owner-secret-token\n');
	const spine = await startSpine(t, { extraArgs: ['--trust-proxy', '--owner-token-file', ownerTokenFile] });
	const tunnels = [];
	t.after(() => { for (const tunnel of tunnels) tunnel.ws.terminate(); });
	// Two nodes per client IP (the per-IP cap), registered in batches that stay
	// under the anonymous-tunnel caps.
	const ipFor = i => `203.0.${Math.floor(i / 2 / 256)}.${Math.floor(i / 2) % 256}`;
	const keys = [];
	for (let start = 0; start < maxNodes; start += 40) {
		const batch = [];
		for (let i = start; i < Math.min(maxNodes, start + 40); i++) {
			keys[i] = crypto.randomBytes(32).toString('base64url');
			batch.push(connectNode(spine.relayWsPort, registerMsg({ nodeKey: keys[i] }), { headers: { 'x-forwarded-for': ipFor(i) } }));
		}
		for (const tunnel of await Promise.all(batch)) {
			assert.equal((await tunnel.reply).t, 'registered');
			tunnels.push(tunnel);
		}
	}
	const newcomer = await connectNode(spine.relayWsPort, registerMsg(), { headers: { 'x-forwarded-for': '198.51.100.200' } });
	assert.equal((await newcomer.closed).code, 1013, 'a full relay must refuse a new node');
	// A protocol-1 owner registration has no identity to replace: the cap is absolute.
	const legacyOwner = await connectNode(spine.relayWsPort, { t: 'register', geo: '', capacity: 2 }, { bearer: 'owner-secret-token', headers: { 'x-forwarded-for': '198.51.100.201' } });
	assert.equal((await legacyOwner.closed).code, 1013, 'a full relay must refuse a protocol-1 owner too');
	const again = await connectNode(spine.relayWsPort, registerMsg({ nodeKey: keys[0] }), { headers: { 'x-forwarded-for': ipFor(0) } });
	assert.equal((await again.reply).t, 'registered', `a node replacing its own tunnel must not be refused\n${spine.log().slice(-600)}`);
	assert.equal((await tunnels[0].closed).code, 4002);
	tunnels.push(again);
});
