// Relay tunnel rotation (make-before-break): an idle node moves to a fresh
// tunnel so Caddy's delayed stream close after a reload never cuts a match.
// A fake relay drives each handover step deterministically.
// Run: node --test tunnel-rotation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { makeNodeTree, reservePort } from './roomhost-fixture.mjs';

async function fakeRelay(t, onRegister) {
	const server = http.createServer();
	const wss = new WebSocketServer({ server, path: '/node' });
	const tunnels = [];
	wss.on('connection', ws => {
		const tunnel = { ws, index: tunnels.length, messages: [], binary: [] };
		tunnel.closed = new Promise(resolve => ws.on('close', code => resolve(code)));
		ws.on('message', (data, isBinary) => {
			if (isBinary) { tunnel.binary.push(Buffer.from(data)); return; }
			const msg = JSON.parse(String(data));
			tunnel.messages.push(msg);
			if (msg.t === 'register') onRegister(tunnel, tunnels);
		});
		tunnels.push(tunnel);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => {
		for (const tunnel of tunnels) tunnel.ws.terminate();
		wss.close();
		server.close();
	});
	return { url: `ws://127.0.0.1:${server.address().port}`, tunnels };
}

// What the relay does on a register: accept it and replace an older tunnel of the same node.
function acceptAndReplace(tunnel, tunnels) {
	tunnel.ws.send(JSON.stringify({ t: 'registered', nodeId: 'fixturenode01', tier: 'community' }));
	for (const other of tunnels)
		if (other !== tunnel && other.ws.readyState === other.ws.OPEN) other.ws.close(4002, 'replaced');
}

async function startNode(t, relayUrl, rotateMs, extraArgs = []) {
	const fx = await makeNodeTree(t, { mode: 'echo' });
	const base = await reservePort();
	await base.release();
	let log = '';
	const child = spawnProcessGroup(process.execPath, [`${fx.dir}/steelseed-host/tools/roomhost.mjs`,
		'--http', '0', '--ws', '0', '--base-port', String(base.port), '--data-dir', fx.dataDir, '--spine', relayUrl, ...extraArgs], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...fx.runnerEnv, REDLINE_NODE_KEY: fx.key, REDLINE_TUNNEL_ROTATE_MS: String(rotateMs) },
	});
	child.stdout.on('data', data => { log += data; });
	child.stderr.on('data', data => { log += data; });
	t.after(async () => {
		await stopProcessGroup(child).catch(() => {});
		await fx.cleanup();
	});
	return { fx, log: () => log };
}

async function waitFor(check, ms, why) {
	const deadline = Date.now() + ms;
	while (!await check()) {
		assert.ok(Date.now() < deadline, why());
		await delay(25);
	}
}

const lastStatus = tunnel => tunnel.messages.filter(msg => msg.t === 'status').at(-1);

test('draining a node refuses a new relay player channel', { timeout: 15000 }, async t => {
	const relay = await fakeRelay(t, tunnel =>
		tunnel.ws.send(JSON.stringify({ t: 'registered', nodeId: 'fixturenode01', tier: 'community' })));
	const node = await startNode(t, relay.url, 60_000);
	await waitFor(() => relay.tunnels[0]?.messages.some(msg => msg.t === 'register'), 5000,
		() => `node did not register\n${node.log()}`);
	await waitFor(() => /directory (http:\/\/127\.0\.0\.1:\d+)\/v2\/rooms/.test(node.log()), 5000,
		() => `node API did not start\n${node.log()}`);
	const api = /directory (http:\/\/127\.0\.0\.1:\d+)\/v2\/rooms/.exec(node.log())[1];
	const headers = { 'content-type': 'application/json', 'x-redline-node-key': node.fx.key };
	const created = await fetch(api + '/v2/rooms', { method: 'POST', headers,
		body: JSON.stringify({ map: node.fx.mapUid, slots: 2, name: 'drain-fixture' }), signal: AbortSignal.timeout(5000) });
	assert.equal(created.status, 201, node.log());
	const { room } = await created.json();
	const drain = await fetch(api + '/v2/drain', { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
	assert.equal(drain.status, 200, node.log());
	const tunnel = relay.tunnels[0];
	tunnel.ws.send(JSON.stringify({ t: 'open', chanId: 17, roomId: room.roomId }));
	await waitFor(() => tunnel.messages.some(msg => msg.t === 'close' && msg.chanId === 17), 5000,
		() => `relay channel was admitted during drain\n${node.log()}`);
});

test('a placed lobby and creator hostKey survive rotation through the real relay', { timeout: 30000 }, async t => {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-rotation-spine-'));
	const httpPort = await reservePort(), relayPort = await reservePort();
	await httpPort.release(); await relayPort.release();
	const configPath = path.join(configDir, 'relay.json');
	fs.writeFileSync(configPath, JSON.stringify({ placement: 'donated', browserMultiplayer: 'full' }));
	let spineLog = '';
	const spinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spine.mjs');
	const spine = spawnProcessGroup(process.execPath, [spinePath, '--http', String(httpPort.port), '--ws', String(relayPort.port), '--config', configPath], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	spine.stdout.on('data', data => { spineLog += data; });
	spine.stderr.on('data', data => { spineLog += data; });
	t.after(async () => { await stopProcessGroup(spine).catch(() => {}); fs.rmSync(configDir, { recursive: true, force: true }); });
	const api = `http://127.0.0.1:${httpPort.port}`;
	const get = async pathname => {
		try { const response = await fetch(api + pathname, { signal: AbortSignal.timeout(1000) }); return response.ok ? response.json() : null; }
		catch { return null; }
	};
	await waitFor(async () => (await get('/v2/config'))?.schema === 1, 5000,
		() => `real relay did not start\n${spineLog}`);
	const node = await startNode(t, `ws://127.0.0.1:${relayPort.port}`, 6000, ['--mode', 'donate']);
	await waitFor(async () => (await get('/v2/config'))?.capacity?.donatedFree > 0, 5000,
		() => `donated node did not register\n${node.log()}\n${spineLog}`);
	const placed = await fetch(api + '/v2/rooms', {
		method: 'POST',
		headers: { origin: 'http://127.0.0.1:18077', 'content-type': 'application/json' },
		body: JSON.stringify({ map: node.fx.mapUid, slots: 2, name: 'Rotating lobby' }),
		signal: AbortSignal.timeout(5000),
	});
	const placedBody = await placed.text();
	assert.equal(placed.status, 201, `${placedBody}\n${node.log()}\n${spineLog}`);
	const { room } = JSON.parse(placedBody);
	assert.match(room.hostKey, /^[0-9a-f]{32}$/);
	const join = async payload => {
		const ws = new WebSocket(`${room.wsUrl}?k=${room.hostKey}`, { headers: { origin: 'http://127.0.0.1:18077' } });
		ws.on('error', () => {});
		await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
		const echo = once(ws, 'message', { signal: AbortSignal.timeout(5000) });
		ws.send(payload);
		assert.deepEqual(Buffer.from((await echo)[0]), Buffer.from(payload));
		const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) });
		ws.close(); await closed;
	};
	await join('before-rotation');
	await waitFor(async () => (await get('/v2/rooms'))?.rooms?.some(value => value.roomId === room.roomId && value.state === 'lobby'), 5000,
		() => `placed room never reached lobby\n${node.log()}\n${spineLog}`);
	await waitFor(() => /spine tunnel rotated/.test(node.log()), 12000,
		() => `real relay handover did not complete\n${node.log()}\n${spineLog}`);
	assert.ok((await get('/v2/rooms'))?.rooms?.some(value => value.roomId === room.roomId), 'placed lobby vanished after rotation');
	await join('after-rotation');
});

test('closing the old tunnel after a successor channel opens leaves that channel usable', { timeout: 30000 }, async t => {
	const relay = await fakeRelay(t, tunnel => {
		// Keep the old socket open briefly after the successor registers. This
		// forces its close handler to run after the new channel is already live.
		tunnel.ws.send(JSON.stringify({ t: 'registered', nodeId: 'fixturenode01', tier: 'community' }));
	});
	const node = await startNode(t, relay.url, 1500);
	await waitFor(() => relay.tunnels[0]?.messages.some(msg => msg.t === 'register'), 5000,
		() => `first tunnel did not register\n${node.log()}`);
	const first = relay.tunnels[0];
	first.ws.send(JSON.stringify({ t: 'create', reqId: 'keep-channel', map: 'a'.repeat(40), slots: 2, name: 'keep' }));
	await waitFor(() => first.messages.some(msg => msg.t === 'create-ok' && msg.reqId === 'keep-channel'), 5000,
		() => `room was not created\n${node.log()}`);
	const roomId = first.messages.find(msg => msg.t === 'create-ok' && msg.reqId === 'keep-channel').roomId;
	await waitFor(() => relay.tunnels[1]?.messages.some(msg => msg.t === 'register'), 10000,
		() => `idle lobby did not rotate\n${node.log()}`);
	const second = relay.tunnels[1];
	await waitFor(() => /spine tunnel rotated/.test(node.log()), 5000,
		() => `successor did not become current\n${node.log()}`);
	second.ws.send(JSON.stringify({ t: 'open', chanId: 7, roomId }));
	const packet = word => {
		const bytes = Buffer.from(word);
		const frame = Buffer.alloc(2 + bytes.length);
		frame.writeUInt16BE(7, 0);
		bytes.copy(frame, 2);
		return frame;
	};
	second.ws.send(packet('before'));
	await waitFor(() => second.binary.some(frame => frame.equals(packet('before'))), 5000,
		() => `successor channel did not echo before old close\n${node.log()}`);
	first.ws.close(4002, 'replaced');
	assert.equal(await first.closed, 4002);
	second.ws.send(packet('after'));
	await waitFor(() => second.binary.some(frame => frame.equals(packet('after'))), 5000,
		() => `old close destroyed successor channel\n${node.log()}`);
	assert.equal(second.ws.readyState, second.ws.OPEN);
});

test('an idle node rotates to a successor tunnel before dropping the old one', { timeout: 30000 }, async t => {
	const relay = await fakeRelay(t, acceptAndReplace);
	const node = await startNode(t, relay.url, 1500);
	await waitFor(() => relay.tunnels.length >= 2 && relay.tunnels[1].messages.some(msg => msg.t === 'register'), 10000,
		() => `no successor tunnel registered\n${node.log()}`);
	const [first, second] = relay.tunnels;
	// Admissions froze on the old tunnel for the handover.
	assert.equal(lastStatus(first)?.freeMatches, 0, 'the old tunnel must advertise no free matches during the handover');
	assert.equal(await first.closed, 4002);
	// The successor is current: it re-reports rooms and advertises capacity again.
	await waitFor(() => second.messages.some(msg => msg.t === 'rooms') && lastStatus(second)?.freeMatches > 0, 5000,
		() => `successor never took over\n${node.log()}`);
	assert.match(node.log(), /spine tunnel rotated/);
	// The replaced tunnel's 4002 close must not start a reconnect of its own.
	assert.doesNotMatch(node.log(), /reconnecting in/, node.log());
});

test('a refused successor keeps the current tunnel and lifts the freeze', { timeout: 30000 }, async t => {
	const relay = await fakeRelay(t, (tunnel, tunnels) => {
		if (tunnel.index === 1) tunnel.ws.close(4004, 'too many nodes from this IP');
		else acceptAndReplace(tunnel, tunnels);
	});
	const node = await startNode(t, relay.url, 1500);
	await waitFor(() => relay.tunnels.length >= 2, 10000, () => `no rotation attempt\n${node.log()}`);
	const [first, second] = relay.tunnels;
	assert.equal(await second.closed, 4004);
	await waitFor(() => /spine tunnel rotation failed/.test(node.log()) && lastStatus(first)?.freeMatches > 0, 5000,
		() => `freeze was not lifted on the current tunnel\n${node.log()}`);
	assert.equal(first.ws.readyState, first.ws.OPEN, 'the current tunnel must stay up');
	assert.doesNotMatch(node.log(), /reconnecting in/, node.log());
});

test('a create that reaches the old tunnel during the handover is refused, not placed', { timeout: 30000 }, async t => {
	let answered = null;
	const relay = await fakeRelay(t, (tunnel, tunnels) => {
		if (tunnel.index !== 1) { acceptAndReplace(tunnel, tunnels); return; }
		// The successor has registered but is not accepted yet: a create still lands on the old tunnel.
		const first = tunnels[0];
		first.ws.send(JSON.stringify({ t: 'create', reqId: 'late-1', map: 'f'.repeat(40), slots: 2, name: 'late' }));
		answered = (async () => {
			await waitFor(() => first.messages.some(msg => msg.reqId === 'late-1'), 5000, () => 'create never answered');
			acceptAndReplace(tunnel, tunnels);
			return first.messages.find(msg => msg.reqId === 'late-1');
		})();
	});
	const node = await startNode(t, relay.url, 1500);
	await waitFor(() => answered !== null, 10000, () => `no rotation attempt\n${node.log()}`);
	const reply = await answered;
	assert.deepEqual({ t: reply.t, error: reply.error }, { t: 'create-fail', error: 'no-capacity' }, node.log());
	assert.doesNotMatch(node.log(), /spine room .* created/, 'no room may be allocated during the handover');
});

for (const order of ['current first', 'successor first']) {
	test(`a build retired during the handover emits update-required once and stops (${order})`, { timeout: 30000 }, async t => {
		const relay = await fakeRelay(t, (tunnel, tunnels) => {
			if (tunnel.index !== 1) { acceptAndReplace(tunnel, tunnels); return; }
			// The relay retired this build (SIGHUP): both tunnels are refused with 4003.
			const [first, second] = [tunnels[0], tunnel];
			const [a, b] = order === 'current first' ? [first, second] : [second, first];
			a.ws.close(4003, 'bbbbbbbbbbbb');
			setTimeout(() => b.ws.close(4003, 'bbbbbbbbbbbb'), 200);
		});
		const node = await startNode(t, relay.url, 1500);
		await waitFor(() => relay.tunnels.length >= 2, 10000, () => `no rotation attempt\n${node.log()}`);
		await Promise.all(relay.tunnels.map(tunnel => tunnel.closed));
		await delay(2500);
		const events = node.log().match(/\[\[redline-node\]\] \{"event":"update-required"/g) ?? [];
		assert.equal(events.length, 1, `update-required must be emitted exactly once\n${node.log()}`);
		assert.doesNotMatch(node.log(), /reconnecting in/, node.log());
		assert.equal(relay.tunnels.length, 2, 'a retired build must not dial again');
	});
}

test('a retired successor also stops the still-open old tunnel', { timeout: 30000 }, async t => {
	const relay = await fakeRelay(t, (tunnel, tunnels) => {
		if (tunnel.index === 0) { acceptAndReplace(tunnel, tunnels); return; }
		// A build refusal can reach the candidate before the old relay socket
		// receives its own close. The old socket must not keep accepting rooms.
		tunnel.ws.close(4003, 'bbbbbbbbbbbb');
	});
	const node = await startNode(t, relay.url, 1500);
	await waitFor(() => relay.tunnels.length >= 2, 10000, () => `no rotation attempt\n${node.log()}`);
	const [old, candidate] = relay.tunnels;
	assert.equal(await candidate.closed, 4003);
	await waitFor(() => /"event":"update-required"/.test(node.log()), 3000,
		() => `update-required was not emitted\n${node.log()}`);
	const oldStopped = await Promise.race([
		old.closed.then(() => true),
		delay(2500).then(() => false),
	]);
	assert.equal(oldStopped, true, `retired node kept its old public tunnel open\n${node.log()}`);
	assert.equal((node.log().match(/"event":"update-required"/g) ?? []).length, 1);
});
