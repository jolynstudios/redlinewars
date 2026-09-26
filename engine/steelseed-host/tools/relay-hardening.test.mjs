// Relay hardening: node registration is open to anyone, and the relay sits on the public internet,
// so nothing a peer sends may take the process (and every tunnel and match with it) down.
// Boots the real spine on loopback and checks that it survives:
//   - a registered node sending JSON that is not an object (null, arrays, strings, numbers) and a
//     `rooms` report whose rooms are not an array;
//   - HTTP requests and WebSocket upgrades with a malformed Host header;
// and that `join` mode lets site browsers join but never place (host) rooms.
// Run: node --test relay-hardening.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { reservePort } from './roomhost-fixture.mjs';

const spinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spine.mjs');

function httpJson(port, pathname, { method = 'GET', headers = {}, body = null } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => {
			let data = '';
			res.on('data', c => { data += c; });
			res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data) }));
		});
		req.on('error', reject);
		req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
		if (body !== null) req.write(body);
		req.end();
	});
}

/** A raw request, so the Host header can be anything at all. Resolves on any answer or close. */
function rawRequest(port, text) {
	return new Promise(resolve => {
		const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
		let answer = '';
		socket.on('data', c => { answer += c; });
		socket.on('error', () => resolve(answer));
		socket.on('close', () => resolve(answer));
		socket.setTimeout(3000, () => socket.destroy());
	});
}

async function startSpine(t, config) {
	const httpPort = await reservePort();
	const wsPort = await reservePort();
	await httpPort.release();
	await wsPort.release();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hardening-'));
	const configFile = path.join(tmp, 'relay.json');
	fs.writeFileSync(configFile, JSON.stringify(config));
	const proc = spawnProcessGroup(process.execPath, [spinePath, '--http', String(httpPort.port), '--ws', String(wsPort.port), '--config', configFile], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: process.env,
	});
	let log = '';
	let exited = null;
	proc.stdout.on('data', c => { log += c; });
	proc.stderr.on('data', c => { log += c; });
	proc.on('exit', code => { exited = code; });
	t.after(async () => {
		try { await stopProcessGroup(proc); } catch { /* already gone */ }
		fs.rmSync(tmp, { recursive: true, force: true });
	});
	for (let i = 0; ; i++) {
		const ok = await httpJson(httpPort.port, '/v2/config').then(r => r.status === 200).catch(() => false);
		if (ok) break;
		assert.ok(i < 200, `spine never became ready\n${log}`);
		await delay(50);
	}
	return { httpPort: httpPort.port, wsPort: wsPort.port, alive: () => exited === null, log: () => log };
}

const CONFIG = {
	publicUrl: 'https://play.example',
	siteOrigins: ['https://www.example'],
	browserMultiplayer: 'full',
	placement: 'donated',
	acceptedBuilds: ['devbuild01'],
};

async function assertAlive(spine, why) {
	await delay(300);
	assert.ok(spine.alive(), `${why}: the relay process exited\n${spine.log()}`);
	const config = await httpJson(spine.httpPort, '/v2/config');
	assert.equal(config.status, 200, `${why}: the relay no longer answers`);
}

test('a registered node cannot crash the relay with malformed messages', async t => {
	const spine = await startSpine(t, CONFIG);
	const ws = new WebSocket(`ws://127.0.0.1:${spine.wsPort}/node`);
	ws.on('error', () => {});
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	const registered = new Promise(resolve => ws.once('message', data => resolve(JSON.parse(String(data)))));
	const nodeKey = Buffer.concat([Buffer.alloc(31, 0x5a), Buffer.from([1])]).toString('base64url');
	ws.send(JSON.stringify({ t: 'register', proto: 2, nodeKey, build: 'devbuild01', mode: 'own', name: 'fixture', maxMatches: 1, app: '0.0.0-test' }));
	assert.equal((await registered).t, 'registered');
	for (const junk of ['null', '[]', '[1,2,3]', '"rooms"', '42', 'true',
		'{"t":"rooms","rooms":{}}', '{"t":"rooms","rooms":"x"}', '{"t":"rooms","rooms":null}', '{"t":"rooms","rooms":[null,1,"x",{}]}',
		'{"t":"create-ok","reqId":{},"roomId":[]}', '{"t":"status","freeMatches":{},"players":[]}', '{"t":"close","chanId":{}}'])
		ws.send(junk);
	await assertAlive(spine, 'after malformed node messages');
	assert.equal(ws.readyState, WebSocket.OPEN, 'the node tunnel itself stays up');
	ws.close();
});

test('a malformed Host header never crashes the relay', async t => {
	const spine = await startSpine(t, CONFIG);
	for (const host of ['[', 'a b', '%', 'exa mple:99999', '::::', '']) {
		await rawRequest(spine.httpPort, `GET /v2/config HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
		await rawRequest(spine.wsPort, `GET /node HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
		await rawRequest(spine.wsPort, `GET /g/0123456789abcdef HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
	}
	await assertAlive(spine, 'after malformed Host headers');
});

test('join mode lets site browsers join but never host', async t => {
	const spine = await startSpine(t, { ...CONFIG, browserMultiplayer: 'join' });
	const post = await httpJson(spine.httpPort, '/v2/rooms', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: 'https://www.example' },
		body: JSON.stringify({ map: '0'.repeat(40), slots: 2 }),
	});
	assert.equal(post.status, 403);
	assert.deepEqual(post.json(), { error: 'browser-multiplayer-off' });
	await assertAlive(spine, 'after a join-mode placement attempt');
});
