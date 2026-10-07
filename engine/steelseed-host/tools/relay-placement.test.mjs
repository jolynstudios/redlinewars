// T6.1–T6.3: relay placement, failover, hostKey admission and one-room-per-IP.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { reservePort } from './roomhost-fixture.mjs';
import { hostKeyHash, signClaim } from './ranked-claims.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const spinePath = path.join(scriptDir, 'spine.mjs');
const MAP_UID = 'c6a14c146c2630a23783091d5d0d96341137f4d0';
const BROWSER_ORIGIN = 'http://127.0.0.1:18077';

function httpJson(port, pathname, { method = 'GET', headers = {}, body = null } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => {
			let data = '';
			res.on('data', chunk => { data += chunk; });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
		});
		req.on('error', reject);
		if (body !== null) req.write(body);
		req.end();
	});
}

function nodeKey(seed) {
	return crypto.createHash('sha256').update(`placement-${seed}`).digest().toString('base64url');
}

function nodeIdFor(key) {
	return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

async function startSpine(t, { placement = 'donated', ownerOverflow = undefined, ownerToken = null, env = {} } = {}) {
	const httpPort = await reservePort();
	const relayPort = await reservePort();
	await httpPort.release();
	await relayPort.release();
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-placement-'));
	const config = path.join(configDir, 'relay.json');
	fs.writeFileSync(config, JSON.stringify({ placement, ownerOverflow, browserMultiplayer: 'full' }));
	const ownerArgs = ownerToken ? ['--owner-token-file', ownerToken] : [];
	const proc = spawnProcessGroup(process.execPath, [spinePath, '--http', String(httpPort.port), '--ws', String(relayPort.port), '--config', config, ...ownerArgs], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
	t.after(async () => {
		try { await stopProcessGroup(proc); } catch { /* already stopped */ }
		fs.rmSync(configDir, { recursive: true, force: true });
	});
	for (let i = 0; i < 100; i++) {
		try {
			if ((await httpJson(httpPort.port, '/v2/config')).status === 200) break;
		} catch { /* booting */ }
		await delay(50);
	}
	return { httpPort: httpPort.port, relayPort: relayPort.port };
}

async function connectNode(port, key, onCreate, bearer = null, registerExtras = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/node`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined);
	ws.on('error', () => { /* close is observed by the caller */ });
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	ws.on('message', data => {
		let msg;
		try { msg = JSON.parse(String(data)); } catch { return; }
		if (msg.t === 'create') onCreate?.(ws, msg);
	});
	ws.send(JSON.stringify({
		t: 'register', proto: 2, nodeKey: key, build: 'placement-test', mode: 'donate',
		name: 'fixture', maxMatches: 1, app: 'test', slots: { freeMatches: 1 },
		health: { healthy: true, degraded: false }, ...registerExtras,
	}));
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('node registration timeout')), 5000);
		ws.on('message', data => { try { if (JSON.parse(String(data)).t === 'registered') { clearTimeout(timer); resolve(); } } catch {} });
	});
	return ws;
}

test('placement tries the next donated node and returns a creator hostKey', { timeout: 30000 }, async t => {
	const spine = await startSpine(t);
	let createAttempts = 0;
	let firstNodeId = null;
	const bad = await connectNode(spine.relayPort, nodeKey('bad'), (_ws, msg) => {
		createAttempts++;
		firstNodeId ??= 'bad';
		if (createAttempts === 1)
			_ws.send(JSON.stringify({ t: 'create-fail', reqId: msg.reqId, error: 'no-capacity' }));
		else
			_ws.send(JSON.stringify({ t: 'create-ok', reqId: msg.reqId, roomId: 'aa11bb22cc33dd44', summary: { roomId: 'aa11bb22cc33dd44', name: msg.name, map: msg.map, slots: msg.slots, players: 0 } }));
	});
	let healthyCreate = null;
	const healthy = await connectNode(spine.relayPort, nodeKey('healthy'), (_ws, msg) => {
		createAttempts++;
		firstNodeId ??= 'healthy';
		healthyCreate = msg;
		if (createAttempts === 1)
			_ws.send(JSON.stringify({ t: 'create-fail', reqId: msg.reqId, error: 'no-capacity' }));
		else
			_ws.send(JSON.stringify({ t: 'create-ok', reqId: msg.reqId, roomId: 'aa11bb22cc33dd44', summary: { roomId: 'aa11bb22cc33dd44', name: msg.name, map: msg.map, slots: msg.slots, players: 0 } }));
	});
	t.after(() => { bad.close(); healthy.close(); });
	await delay(250); // allow the relay's first RTT ping to complete
	const result = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 2, name: 'Placed' }),
	});
	assert.equal(result.status, 201);
	assert.equal(createAttempts, 2, `expected one failed candidate and one fallback (first=${firstNodeId})`);
	assert.equal(healthyCreate?.map ?? MAP_UID, MAP_UID);
	const room = result.json().room;
	assert.equal(room.roomId, 'aa11bb22cc33dd44');
	assert.match(room.hostKey, /^[0-9a-f]{32}$/);
	assert.equal(room.hostKind, 'donated');

	const second = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 2, name: 'Second' }),
	});
	assert.equal(second.status, 429);
	assert.deepEqual(second.json(), { error: 'one-room-per-ip' });
});

test('a blackholing donated candidate times out before owner fallback', { timeout: 25000 }, async t => {
	const ownerTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-owner-fallback-'));
	const ownerTokenFile = path.join(ownerTokenDir, 'owner-token');
	fs.writeFileSync(ownerTokenFile, 'owner-secret\n', { mode: 0o600 });
	t.after(() => fs.rmSync(ownerTokenDir, { recursive: true, force: true }));
	const spine = await startSpine(t, { placement: 'donated+owner', ownerOverflow: true, ownerToken: ownerTokenFile });
	const attempts = [];
	const donated = await connectNode(spine.relayPort, nodeKey('blackhole-donated'), (_ws, _msg) => {
		attempts.push('donated');
		// Deliberately never answer `create`.
	});
	const owner = await connectNode(spine.relayPort, nodeKey('fallback-owner'), (ws, msg) => {
		attempts.push('owner');
		ws.send(JSON.stringify({ t: 'create-ok', reqId: msg.reqId, roomId: 'cc33dd44ee55ff66',
			summary: { roomId: 'cc33dd44ee55ff66', name: msg.name, map: msg.map, slots: msg.slots, players: 0 } }));
	}, 'owner-secret');
	t.after(() => { donated.close(); owner.close(); });
	await delay(250);
	const started = Date.now();
	const response = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 2, name: 'Owner fallback' }),
	});
	const elapsed = Date.now() - started;
	assert.equal(response.status, 201, response.body);
	assert.deepEqual(attempts, ['donated', 'owner']);
	assert.equal(response.json().room.hostKind, 'owner');
	assert.ok(elapsed >= 14_500 && elapsed < 20_000, `expected 15s donated timeout then owner success, got ${elapsed}ms`);
});

test('placement is limited to three create attempts per ten minutes per ipKey', async t => {
	const spine = await startSpine(t);
	for (let attempt = 1; attempt <= 3; attempt++) {
		const response = await httpJson(spine.httpPort, '/v2/rooms', {
			method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
			body: JSON.stringify({ map: MAP_UID, slots: 2, name: `Attempt ${attempt}` }),
		});
		assert.equal(response.status, 503);
		assert.deepEqual(response.json(), { error: 'no-capacity' });
	}
	const refused = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 2, name: 'Attempt 4' }),
	});
	assert.equal(refused.status, 429);
	assert.deepEqual(refused.json(), { error: 'rate' });
	assert.ok(Number(refused.headers['retry-after']) > 0);
});

test('reserved placed room rejects a non-creator hostKey before opening a node channel', { timeout: 20000 }, async t => {
	const spine = await startSpine(t);
	let openMessage;
	const node = await connectNode(spine.relayPort, nodeKey('hostkey'), (ws, msg) => {
		ws.send(JSON.stringify({ t: 'create-ok', reqId: msg.reqId, roomId: 'bb22cc33dd44ee55', summary: { roomId: 'bb22cc33dd44ee55', map: msg.map, slots: msg.slots, players: 0 } }));
	});
	node.on('message', data => { try { const msg = JSON.parse(String(data)); if (msg.t === 'open') openMessage = msg; } catch {} });
	t.after(() => node.close());
	await delay(250);
	const result = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 2, name: 'Claimed' }),
	});
	assert.equal(result.status, 201);
	const room = result.json().room;
	node.send(JSON.stringify({ t: 'rooms', rooms: [{ roomId: room.roomId, mapUid: MAP_UID, slots: 2, players: 0, state: 'reserved' }] }));
	await delay(100);
	const rejected = new WebSocket(`${room.wsUrl}?k=wrong`);
	const rejectedClose = new Promise(resolve => rejected.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
	const rejectVerdict = await rejectedClose;
	assert.equal(rejectVerdict.code, 4404);
	assert.equal(openMessage, undefined);
	const accepted = new WebSocket(`${room.wsUrl}?k=${room.hostKey}`);
	await new Promise((resolve, reject) => { accepted.once('open', resolve); accepted.once('error', reject); });
	for (let i = 0; i < 20 && !openMessage; i++) await delay(20);
	assert.equal(openMessage?.hostKey, room.hostKey);
	accepted.close();
});

test('config reports healthy donated and owner free capacity separately', { timeout: 20000 }, async t => {
	const ownerTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-capacity-owner-'));
	const ownerTokenFile = path.join(ownerTokenDir, 'owner-token');
	fs.writeFileSync(ownerTokenFile, 'owner-secret\n', { mode: 0o600 });
	t.after(() => fs.rmSync(ownerTokenDir, { recursive: true, force: true }));
	const spine = await startSpine(t, { placement: 'donated+owner', ownerToken: ownerTokenFile });
	const donated = await connectNode(spine.relayPort, nodeKey('capacity-donated'), null);
	const owner = await connectNode(spine.relayPort, nodeKey('capacity-owner'), null, 'owner-secret');
	t.after(() => { donated.close(); owner.close(); });
	await delay(250);
	const config = (await httpJson(spine.httpPort, '/v2/config')).json();
	// Without ownerOverflow the owner node serves Ranked only, so ordinary hosting sees none of it.
	assert.deepEqual(config.capacity, { donatedFree: 1, ownerFree: 0, rankedOwnerFree: 1 });
});

test('ordinary placement never uses the owner node unless ownerOverflow is on', { timeout: 20000 }, async t => {
	const ownerTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-no-overflow-'));
	const ownerTokenFile = path.join(ownerTokenDir, 'owner-token');
	fs.writeFileSync(ownerTokenFile, 'owner-secret\n', { mode: 0o600 });
	t.after(() => fs.rmSync(ownerTokenDir, { recursive: true, force: true }));
	const spine = await startSpine(t, { placement: 'donated+owner', ownerToken: ownerTokenFile });
	const attempts = [];
	const owner = await connectNode(spine.relayPort, nodeKey('no-overflow-owner'), (ws, msg) => {
		attempts.push('owner');
		ws.send(JSON.stringify({ t: 'create-ok', reqId: msg.reqId, roomId: 'dd44ee55ff660011',
			summary: { roomId: 'dd44ee55ff660011', name: msg.name, map: msg.map, slots: msg.slots, players: 0 } }));
	}, 'owner-secret');
	t.after(() => owner.close());
	await delay(250);
	const response = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 2, name: 'No donors' }),
	});
	assert.equal(response.status, 503, response.body);
	assert.equal(response.json().error, 'no-capacity');
	assert.deepEqual(attempts, [], 'the owner node must not be asked for an ordinary room');
	const config = (await httpJson(spine.httpPort, '/v2/config')).json();
	assert.deepEqual(config.capacity, { donatedFree: 0, ownerFree: 0, rankedOwnerFree: 1 });
});

test('ranked placement consumes a signed pre-issued hostKey and participant claim once', { timeout: 30000 }, async t => {
	const secret = 'ranked-placement-test-secret-0123456789';
	const provisionToken = 'ranked-provision-test-secret';
	const rulesHash = 'a'.repeat(64);
	const ownerTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-placement-owner-'));
	const ownerTokenFile = path.join(ownerTokenDir, 'owner-token');
	fs.writeFileSync(ownerTokenFile, 'owner-secret\n', { mode: 0o600 });
	t.after(() => fs.rmSync(ownerTokenDir, { recursive: true, force: true }));
	const spine = await startSpine(t, {
		placement: 'donated+owner',
		ownerToken: ownerTokenFile,
		env: {
			REDLINE_RANKED_CLAIM_SECRET: secret,
			REDLINE_RANKED_PROVISION_TOKEN: provisionToken,
			REDLINE_RANKED_RULES_HASH: rulesHash,
			REDLINE_RANKED_PROVISION_TTL_MS: '4000',
		},
	});
	const key = nodeKey('ranked-owner');
	const nodeId = nodeIdFor(key);
	const unauthorized = await httpJson(spine.httpPort, '/v2/ranked/provision', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ mapUid: MAP_UID, slots: 2 }),
	});
	assert.equal(unauthorized.status, 403);
	assert.deepEqual(unauthorized.json(), { error: 'provision-auth-required' });
	const node = await connectNode(spine.relayPort, key, null, 'owner-secret', { rulesHash });
	t.after(() => node.close());
	await delay(250);
	const expiring = await httpJson(spine.httpPort, '/v2/ranked/provision', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${provisionToken}` },
		body: JSON.stringify({ mapUid: MAP_UID, slots: 2, idempotencyKey: 'expiry-probe' }),
	});
	assert.equal(expiring.status, 201);
	await delay(4200);
	const reissued = await httpJson(spine.httpPort, '/v2/ranked/provision', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${provisionToken}` },
		body: JSON.stringify({ mapUid: MAP_UID, slots: 2, idempotencyKey: 'expiry-probe' }),
	});
	assert.equal(reissued.status, 201);
	assert.notEqual(reissued.json().hostKey, expiring.json().hostKey, 'expired reservation must not be replayed');
	const provision = await httpJson(spine.httpPort, '/v2/ranked/provision', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${provisionToken}` },
		body: JSON.stringify({ mapUid: MAP_UID, slots: 2, idempotencyKey: 'account-match-1' }),
	});
	assert.equal(provision.status, 201, provision.body);
	const reservation = provision.json();
	assert.deepEqual(Object.keys(reservation).sort(), ['expiresAt', 'hostKey', 'mapUid', 'nodeId', 'reservationTtlMs', 'roomId', 'rulesHash', 'schema', 'simBuild', 'slots', 'wsUrl'].sort());
	assert.equal(reservation.nodeId, nodeId);
	assert.equal(reservation.simBuild, 'placement-test');
	assert.equal(reservation.mapUid, MAP_UID);
	assert.equal(reservation.rulesHash, rulesHash);
	assert.match(reservation.hostKey, /^[0-9a-f]{32}$/);
	assert.match(reservation.roomId, /^[0-9a-f]{16}$/);
	const again = await httpJson(spine.httpPort, '/v2/ranked/provision', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${provisionToken}` },
		body: JSON.stringify({ mapUid: MAP_UID, slots: 2, idempotencyKey: 'account-match-1' }),
	});
	assert.equal(again.status, 200);
	assert.deepEqual(again.json(), reservation);
	const hostKey = reservation.hostKey;
	const now = Date.now();
	const roomClaim = {
		schema: 2, kid: 'fixture', matchId: 'ranked-match-1', roomId: reservation.roomId,
		tier: 'owner', mode: 'ranked', nodeId: reservation.nodeId, simBuild: reservation.simBuild, mapUid: reservation.mapUid,
		rulesHash: reservation.rulesHash, issuedAt: now - 1000, expiresAt: now + 60_000,
		nonce: 'room-nonce-1', hostKeyHash: hostKeyHash(hostKey),
	};
	const participant = seat => ({
		room: roomClaim, userId: `user-${seat}`, seat, team: seat - 1,
		profileVersion: 1, participantNonce: `participant-nonce-${seat}`,
	});
	const roomToken = signClaim(roomClaim, secret);
	const participantTokens = [1, 2].map(seat => signClaim(participant(seat), secret));
	let createMessage;
	let openMessage;
	// Replace the registration listener with the create/open assertions while
	// retaining the already-connected owner node used by the provision call.
	node.on('message', data => {
		let msg;
		try { msg = JSON.parse(String(data)); } catch { return; }
		if (msg.t !== 'create') return;
		createMessage = msg;
		assert.equal(msg.ranked, true);
		assert.equal(msg.roomId, roomClaim.roomId);
		assert.equal(msg.hostKey, hostKey);
		assert.equal(msg.roomClaim, roomToken);
		assert.deepEqual(msg.participantClaims, participantTokens);
		node.send(JSON.stringify({ t: 'create-ok', reqId: msg.reqId, roomId: roomClaim.roomId,
			summary: { roomId: roomClaim.roomId, name: 'Ranked', mapUid: MAP_UID, slots: 2, players: 0 } }));
		setTimeout(() => node.send(JSON.stringify({ t: 'rooms', rooms: [{ roomId: roomClaim.roomId,
			mapUid: MAP_UID, slots: 2, players: 0, state: 'lobby' }] })), 20);
	});
	node.on('message', data => {
		try { const msg = JSON.parse(String(data)); if (msg.t === 'open') openMessage = msg; } catch { /* fixture */ }
	});
	const result = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${provisionToken}` },
		body: JSON.stringify({ ranked: true, hostKey, roomClaim: roomToken,
			participantClaims: participantTokens, map: MAP_UID, slots: 2, name: 'Ranked' }),
	});
	assert.equal(result.status, 201, result.body);
	const room = result.json().room;
	assert.equal(room.roomId, roomClaim.roomId);
	assert.equal(room.hostKind, 'owner');
	assert.equal('hostKey' in room, false, 'ranked hostKey must not be public');
	assert.equal(createMessage?.hostKey, hostKey);

	const accepted = new WebSocket(`${room.wsUrl}?claim=${encodeURIComponent(participantTokens[0])}`);
	await new Promise((resolve, reject) => { accepted.once('open', resolve); accepted.once('error', reject); });
	for (let i = 0; i < 20 && !openMessage; i++) await delay(20);
	assert.equal(openMessage?.claim, participantTokens[0]);
	accepted.close();
	const replay = new WebSocket(`${room.wsUrl}?claim=${encodeURIComponent(participantTokens[0])}`);
	const verdict = await new Promise(resolve => replay.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
	assert.equal(verdict.code, 4404);
	const duplicate = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${provisionToken}` },
		body: JSON.stringify({ ranked: true, hostKey, roomClaim: roomToken,
			participantClaims: participantTokens, map: MAP_UID, slots: 2, name: 'Ranked' }),
	});
	assert.equal(duplicate.status, 403);
	assert.deepEqual(duplicate.json(), { error: 'ranked-provision-required' });
});
