// W1: relay-side community placement. A standing node joins the ordinary
// placement pool only when its registration advertises acceptsPlaced, and then
// only for requests within its advertised seat budget (community rooms max 4).
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
	return crypto.createHash('sha256').update(`standing-${seed}`).digest().toString('base64url');
}

async function startSpine(t, { env = {} } = {}) {
	const httpPort = await reservePort();
	const relayPort = await reservePort();
	await httpPort.release();
	await relayPort.release();
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-standing-'));
	const config = path.join(configDir, 'relay.json');
	fs.writeFileSync(config, JSON.stringify({ placement: 'donated', browserMultiplayer: 'full' }));
	const proc = spawnProcessGroup(process.execPath, [spinePath, '--http', String(httpPort.port), '--ws', String(relayPort.port), '--config', config], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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

async function connectNode(port, seed, mode, { onCreate = null, registerExtras = {} } = {}) {
	const key = nodeKey(seed);
	const ws = new WebSocket(`ws://127.0.0.1:${port}/node`);
	ws.on('error', () => { /* close is observed by the caller */ });
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	ws.on('message', data => {
		let msg;
		try { msg = JSON.parse(String(data)); } catch { return; }
		if (msg.t === 'create' && onCreate) onCreate(ws, msg);
	});
	ws.send(JSON.stringify({
		t: 'register', proto: 2, nodeKey: key, build: 'standing-test', mode,
		name: 'fixture', maxMatches: 1, app: 'test', slots: { freeMatches: 1 },
		health: { healthy: true, degraded: false }, ...registerExtras,
	}));
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('node registration timeout')), 5000);
		ws.on('message', data => { try { if (JSON.parse(String(data)).t === 'registered') { clearTimeout(timer); resolve(); } } catch {} });
	});
	return ws;
}

test('an opted-in standing node serves a placed three-seat room as a community host', { timeout: 30000 }, async t => {
	const spine = await startSpine(t);
	let createMessage;
	const standing = await connectNode(spine.relayPort, 'opted-in', 'standing', {
		registerExtras: { acceptsPlaced: true, placedSlotsMax: 4 },
		onCreate: (ws, msg) => {
			createMessage = msg;
			ws.send(JSON.stringify({ t: 'create-ok', reqId: msg.reqId, roomId: 'ee55ff6600112233',
				summary: { roomId: 'ee55ff6600112233', name: msg.name, map: msg.map, slots: msg.slots, players: 0 } }));
		},
	});
	t.after(() => standing.close());
	await delay(250); // first RTT ping must complete before the node is eligible
	const result = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 3, name: 'Community room' }),
	});
	assert.equal(result.status, 201, result.body);
	assert.equal(result.json().room.hostKind, 'community');
	assert.equal(createMessage?.slots, 3);
});

test('a standing node without the opt-in is invisible to ordinary placement', { timeout: 20000 }, async t => {
	const spine = await startSpine(t);
	let asked = 0;
	const standing = await connectNode(spine.relayPort, 'silent-standing', 'standing', {
		onCreate: () => { asked++; },
	});
	t.after(() => standing.close());
	await delay(250);
	const result = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 2, name: 'Nobody home' }),
	});
	assert.equal(result.status, 503);
	assert.equal(result.json().error, 'no-capacity');
	assert.equal(asked, 0, 'the relay must never ask a non-opted standing node');
});

test('a five-seat request skips the standing node and takes the donate node', { timeout: 30000 }, async t => {
	const spine = await startSpine(t);
	const asks = [];
	const standing = await connectNode(spine.relayPort, 'four-seats-only', 'standing', {
		registerExtras: { acceptsPlaced: true, placedSlotsMax: 4 },
		onCreate: () => { asks.push('standing'); },
	});
	const donate = await connectNode(spine.relayPort, 'five-seats', 'donate', {
		onCreate: (ws, msg) => {
			asks.push('donate');
			ws.send(JSON.stringify({ t: 'create-ok', reqId: msg.reqId, roomId: 'ff66001122334455',
				summary: { roomId: 'ff66001122334455', name: msg.name, map: msg.map, slots: msg.slots, players: 0 } }));
		},
	});
	t.after(() => { standing.close(); donate.close(); });
	await delay(250);
	const result = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 5, name: 'Big room' }),
	});
	assert.equal(result.status, 201, result.body);
	assert.equal(result.json().room.hostKind, 'donated');
	assert.deepEqual(asks, ['donate'], 'slots 5 exceeds the community budget — only donate may serve it');
});

test('the advertised seat budget is clamped to the protocol range on registration', { timeout: 20000 }, async t => {
	const spine = await startSpine(t);
	let asked = 0;
	// placedSlotsMax 1 is below slotsMin (2): the relay clamps the
	// advertisement to 2, so a three-seat request must skip this node.
	const standing = await connectNode(spine.relayPort, 'clamped', 'standing', {
		registerExtras: { acceptsPlaced: true, placedSlotsMax: 1 },
		onCreate: () => { asked++; },
	});
	t.after(() => standing.close());
	await delay(250);
	const result = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 3, name: 'Above the clamp' }),
	});
	assert.equal(result.status, 503);
	assert.equal(asked, 0, 'the clamped budget must gate placement, not the raw registration field');
});

// The E2E gates ride this flag (their browsers all share 127.0.0.1); the
// default enforcement is covered by relay-placement's one-room-per-ip test.
test('the E2E relaxation flag lets one address hold several placed rooms', { timeout: 20000 }, async t => {
	const spine = await startSpine(t, { env: { REDLINE_SPINE_RELAX_ROOM_LIMITS: '1' } });
	let counter = 0;
	const donate = await connectNode(spine.relayPort, 'relaxed', 'donate', {
		onCreate: (ws, msg) => {
			const roomId = `ab12cd34ef56${String(++counter).padStart(4, '0')}`;
			ws.send(JSON.stringify({ t: 'create-ok', reqId: msg.reqId, roomId,
				summary: { roomId, name: msg.name, map: msg.map, slots: msg.slots, players: 0 } }));
		},
	});
	t.after(() => donate.close());
	await delay(250);
	const first = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 2, name: 'Relaxed one' }),
	});
	const second = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST', headers: { 'content-type': 'application/json', origin: BROWSER_ORIGIN },
		body: JSON.stringify({ map: MAP_UID, slots: 2, name: 'Relaxed two' }),
	});
	assert.equal(first.status, 201, first.body);
	assert.equal(second.status, 201, second.body);
	assert.notEqual(first.json().room.roomId, second.json().room.roomId);
});

// Regression: /v2/config capacity is what the shipped client's host button
// reads. It must probe at the minimum room size — the default slots parameter
// is Infinity, which silently excluded every standing community node and left
// a standing-only network reporting donatedFree: 0 with free matches (S23).
test('a standing-only network still reports placement capacity to the host button', { timeout: 30000 }, async t => {
	const spine = await startSpine(t);
	const standing = await connectNode(spine.relayPort, 'capacity-only', 'standing', {
		registerExtras: { acceptsPlaced: true, placedSlotsMax: 4 },
	});
	t.after(() => standing.close());
	await delay(250); // first RTT ping must complete before the node is eligible
	const config = await httpJson(spine.httpPort, '/v2/config');
	assert.equal(config.status, 200);
	const capacity = config.json().capacity;
	assert.ok((capacity.donatedFree ?? 0) >= 1,
		`the host button would disable with zero capacity: ${JSON.stringify(capacity)}`);
});
