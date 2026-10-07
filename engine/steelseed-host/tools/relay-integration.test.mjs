import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { makeNodeTree, reservePort } from './roomhost-fixture.mjs';

test('real roomhost WS/TCP roundtrip preserves bytes and isolates disconnects', { timeout: 30000 }, async t => {
	const fx = await makeNodeTree(t, { mode: 'echo' });
	const wsClients = [];
	let child;
	let log = '';
	t.after(async () => {
		for (const ws of wsClients) ws.terminate();
		if (child) await stopProcessGroup(child);
		await fx.cleanup();
	});
	const base = await reservePort();
	child = spawnProcessGroup(process.execPath, [`${fx.dir}/steelseed-host/tools/roomhost.mjs`,
		'--http', '0', '--ws', '0', '--base-port', String(base.port),
		'--data-dir', fx.dataDir, '--idle-kill', '120'], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...fx.runnerEnv, REDLINE_NODE_KEY: fx.key },
	});
	child.stdout.on('data', data => { log += data; });
	child.stderr.on('data', data => { log += data; });
	const deadline = Date.now() + 10000;
	while (!/directory (http:\/\/127\.0\.0\.1:\d+)\/v2\/rooms/.test(log)) {
		assert.equal(child.exitCode, null, log);
		assert.ok(Date.now() < deadline, log);
		await delay(25);
	}
	// The dedicated-port range is only probed at create time — free it here.
	await base.release();
	const baseDir = /directory (http:\/\/127\.0\.0\.1:\d+)\/v2\/rooms/.exec(log)[1];
	const response = await fetch(`${baseDir}/v2/rooms`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-redline-node-key': fx.key },
		body: JSON.stringify({ map: fx.mapUid, slots: 2, name: 'fixture' }), signal: AbortSignal.timeout(3000),
	});
	assert.equal(response.status, 201, log);
	const room = (await response.json()).room;
	async function connect() {
		const ws = new WebSocket(room.wsUrl);
		wsClients.push(ws);
		await once(ws, 'open', { signal: AbortSignal.timeout(3000) });
		return ws;
	}
	// T2.8: the single-room bare-path fallback is gone — with exactly one live
	// room, any dial that is not /g/<roomId> is refused before the handshake.
	const mux = new URL(room.wsUrl.replace(/^ws/, 'http')).port;
	const bare = new WebSocket(`ws://127.0.0.1:${mux}/`);
	wsClients.push(bare);
	const refused = await once(bare, 'error', { signal: AbortSignal.timeout(3000) });
	assert.match(String(refused[0]?.message ?? refused[0]), /404/);
	async function roundtrip(ws, payload) {
		const received = [];
		let size = 0;
		const onMessage = data => { received.push(data); size += data.length; };
		ws.on('message', onMessage);
		try {
			ws.send(payload);
			const end = Date.now() + 3000;
			while (size < payload.length) {
				assert.equal(ws.readyState, WebSocket.OPEN, log);
				assert.ok(Date.now() < end, `roundtrip timeout: ${log}`);
				await delay(10);
			}
			assert.deepEqual(Buffer.concat(received), payload);
		} finally { ws.off('message', onMessage); }
	}
	const first = await connect();
	const second = await connect();
	await roundtrip(first, Buffer.from([0, 255, 1, 128, 13, 10]));
	await roundtrip(second, Buffer.from('second independent channel'));
	const closed = once(first, 'close', { signal: AbortSignal.timeout(3000) });
	first.close();
	await closed;
	await roundtrip(second, Buffer.from('still connected after peer leaves'));
	const drain = await fetch(`${baseDir}/v2/drain`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-redline-node-key': fx.key }, signal: AbortSignal.timeout(3000),
	});
	assert.equal(drain.status, 200, log);
	// A release drain freezes new admissions but lets existing match traffic
	// finish before the installer stops the node.
	const duringDrain = new WebSocket(room.wsUrl);
	wsClients.push(duringDrain);
	const admission = await new Promise(resolve => {
		duringDrain.once('open', () => resolve('opened'));
		duringDrain.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
		duringDrain.once('error', error => resolve(`error: ${error.message}`));
	});
	assert.equal(admission, 503, `new join admitted during drain: ${admission}\n${log}`);
	await roundtrip(second, Buffer.from('existing channel survives drain'));
	assert.equal(child.exitCode, null, log);
});
