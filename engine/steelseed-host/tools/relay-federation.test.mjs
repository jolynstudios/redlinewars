import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { makeNodeTree, reservePort } from './roomhost-fixture.mjs';

const spinePath = fileURLToPath(new URL('./spine.mjs', import.meta.url));
const TOKEN = 'relay-fixture-token';

test('federation: player bytes cross the spine to the dedicated and back', { timeout: 30000 }, async t => {
	const fx = await makeNodeTree(t, { mode: 'echo' });
	const wsClients = [];
	let spine = null;
	let node = null;
	let log = '';
	t.after(async () => {
		for (const ws of wsClients) ws.terminate();
		try { await stopProcessGroup(node); } catch { /* not started */ }
		try { await stopProcessGroup(spine); } catch { /* not started */ }
		await fx.cleanup();
	});
	// Reserved (sockets held by this process) so concurrent test files cannot
	// steal the ports; each is released immediately before its consumer binds.
	const spineWs = await reservePort();
	const spineHttp = await reservePort();
	const nodeMux = await reservePort();
	const base = await reservePort();
	const spineWsPort = spineWs.port;
	const spineHttpPort = spineHttp.port;
	const roomhostWsPort = nodeMux.port;
	await spineWs.release();
	await spineHttp.release();
	spine = spawnProcessGroup(process.execPath, [spinePath,
		'--http', String(spineHttpPort), '--ws', String(spineWsPort)], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, STEELSEED_NODE_TOKEN: TOKEN },
	});
	spine.stdout.on('data', data => { log += `[spine] ${data}`; });
	spine.stderr.on('data', data => { log += `[spine] ${data}`; });
	await nodeMux.release();
	await base.release();
	node = spawnProcessGroup(process.execPath, [`${fx.dir}/steelseed-host/tools/roomhost.mjs`,
		'--http', '0', '--ws', String(roomhostWsPort), '--base-port', String(base.port),
		'--data-dir', fx.dataDir, '--idle-kill', '120',
		'--spine', `ws://127.0.0.1:${spineWsPort}/node`], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...fx.runnerEnv, REDLINE_NODE_TOKEN: TOKEN, REDLINE_NODE_KEY: fx.key },
	});
	node.stdout.on('data', data => { log += `[node] ${data}`; });
	node.stderr.on('data', data => { log += `[node] ${data}`; });
	const readyDeadline = Date.now() + 10000;
	while (!log.includes('live') || !log.includes('spine tunnel open')) {
		assert.ok(Date.now() < readyDeadline, `tunnel never opened\n${log}`);
		await delay(25);
	}
	// Rooms are hosted on the NODE now (§5.3): create through the node's local
	// API and wait for the room to surface on the spine's directory.
	const nodeApiDeadline = Date.now() + 10000;
	let nodeDir = null;
	while (nodeDir === null) {
		const match = /directory (http:\/\/127\.0\.0\.1:\d+)\/v2\/rooms/.exec(log);
		if (match) nodeDir = match[1];
		else {
			assert.ok(Date.now() < nodeApiDeadline, `node api never came up\n${log}`);
			await delay(25);
		}
	}
	const createResponse = await fetch(`${nodeDir}/v2/rooms`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-redline-node-key': fx.key },
		body: JSON.stringify({ map: fx.mapUid, slots: 2, name: 'federation fixture' }), signal: AbortSignal.timeout(5000),
	});
	assert.equal(createResponse.status, 201, log);
	const room = (await createResponse.json()).room;
	// The node reports rooms to the spine only in lobby/playing (T1.4); the
	// player upgrade needs the room listed, so wait for the first report.
	const listedDeadline = Date.now() + 10000;
	let listed = null;
	for (;;) {
		const list = await fetch(`http://127.0.0.1:${spineHttpPort}/v2/rooms`, { signal: AbortSignal.timeout(3000) })
			.then(r => r.json())
			.catch(() => ({ rooms: [] }));
		listed = (list.rooms ?? []).find(r => r.roomId === room.roomId) ?? null;
		if (listed) break;
		assert.ok(Date.now() < listedDeadline, `room never listed: ${log}`);
		await delay(100);
	}
	// T2.3: the relay is authoritative for the player endpoint — the wsUrl
	// points at THIS spine's ws listener, never at a node-local port.
	assert.equal(listed.wsUrl, `ws://127.0.0.1:${spineWsPort}/g/${room.roomId}`);
	const player = new WebSocket(listed.wsUrl);
	wsClients.push(player);
	await once(player, 'open', { signal: AbortSignal.timeout(3000) });
	const payload = Buffer.from('federation roundtrip through spine and tunnel');
	const receivedData = [];
	let size = 0;
	player.on('message', data => {
		receivedData.push(data);
		size += data.length;
	});
	player.send(payload);
	const end = Date.now() + 8000;
	while (size < payload.length) {
		assert.equal(player.readyState, WebSocket.OPEN, log);
		assert.ok(Date.now() < end, `echo timeout: ${log}`);
		await delay(10);
	}
	assert.deepEqual(Buffer.concat(receivedData), payload);
	assert.equal(log.includes('relay backpressure'), false, log);
});
