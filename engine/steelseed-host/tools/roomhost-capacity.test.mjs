import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { makeNodeTree } from './roomhost-fixture.mjs';

const MiB = 1024 * 1024;

async function fixture(t, load, memory, expected, { standing = false, exitOnDrain = false } = {}) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'roomhost-capacity-'));
	const fx = await makeNodeTree(t, { mode: standing ? 'echo' : 'idle' });
	const spine = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	let child;
	let socket;
	const messages = [];
	let log = '';
	t.after(async () => {
		try { await stopProcessGroup(child); }
		finally {
			for (const ws of spine.clients) ws.terminate();
			await new Promise(resolve => spine.close(resolve));
			await rm(dir, { recursive: true, force: true });
			await fx.cleanup();
		}
	});
	await new Promise(resolve => spine.once('listening', resolve));
	spine.on('connection', ws => {
		socket = ws;
		ws.on('message', (data, binary) => {
			if (!binary) messages.push(JSON.parse(String(data)));
		});
	});
	await writeFile(path.join(dir, 'os.mjs'), `import os from 'node:os';\nos.loadavg = () => [${load},${load},${load}];\nos.freemem = () => ${memory};\nprocess.availableMemory = () => ${memory};\nos.totalmem = () => ${8192 * MiB};\nos.cpus = () => Array(4).fill({});\n`);
	if (standing) await writeFile(path.join(dir, 'rooms.json'), JSON.stringify({
		schema: 1, rooms: [{ name: 'Community test', slots: 2, password: '', maps: [fx.mapUid], settings: { gamespeed: 'default', tod: 'auto', weather: 'on' } }],
	}));
	child = spawnProcessGroup(process.execPath, ['--import', pathToFileURL(path.join(dir, 'os.mjs')).href, `${fx.dir}/steelseed-host/tools/roomhost.mjs`,
		'--http', '0', '--ws', '0', '--spine', `ws://127.0.0.1:${spine.address().port}`,
		'--data-dir', fx.dataDir, '--idle-kill', '120',
		...(standing ? ['--mode', 'standing', '--rooms-file', path.join(dir, 'rooms.json')] : []),
		...(exitOnDrain ? ['--exit-on-drain'] : [])], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...fx.runnerEnv, REDLINE_NODE_KEY: fx.key },
	});
	child.stdout.on('data', data => { log += data; });
	child.stderr.on('data', data => { log += data; });
	async function until(predicate) {
		const deadline = Date.now() + 15_000;
		while (!predicate()) {
			assert.equal(child.exitCode, null, log);
			assert.ok(Date.now() < deadline, `fixture readiness timed out: ${log}`);
			await delay(25);
		}
	}
	// The first periodic status follows the sampler; register uses the empty-ring fallback.
	await until(() => messages.some(m => m.t === 'status' && m.healthy === expected.healthy && m.degraded === expected.degraded));
	const match = /directory (http:\/\/127\.0\.0\.1:\d+)\/v2\/rooms/.exec(log);
	assert.ok(match, log);
	async function request(method, body, pathname = '/v2/rooms') {
		const response = await fetch(`${match[1]}${pathname}`, {
			method, signal: AbortSignal.timeout(3000),
			headers: { 'content-type': 'application/json', 'x-redline-node-key': fx.key },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		return { status: response.status, body: await response.json() };
	}
	return { request, async waitForExit() {
		const deadline = Date.now() + 5000;
		while (child.exitCode === null && Date.now() < deadline) await delay(25);
		return child.exitCode;
	}, async createViaSpine() {
		socket.send(JSON.stringify({ t: 'create', reqId: 'capacity-check', map: fx.mapUid, slots: 2, name: 'capacity fixture' }));
		await until(() => messages.some(m => m.reqId === 'capacity-check'));
		return messages.find(m => m.reqId === 'capacity-check');
	} };
}

for (const [name, load, memory] of [['CPU exhausted', 8, 1024 * MiB], ['memory exhausted', 0, 256 * MiB]]) {
	test(`${name}: HTTP and federation refuse rooms`, async t => {
		const f = await fixture(t, load, memory, { healthy: false, degraded: false });
		const response = await f.request('POST', { map: 'a'.repeat(40), slots: 2, name: 'fixture' });
		assert.equal(response.status, 503);
		assert.deepEqual((await f.request('GET')).body.rooms, []);
		assert.equal((await f.createViaSpine()).t, 'create-fail');
		assert.deepEqual((await f.request('GET')).body.rooms, []);
	});
}

test('degraded node admits only two-player rooms', async t => {
	const f = await fixture(t, 4, 300 * MiB, { healthy: false, degraded: true });
	// §5.3 caps slots at 5 (owner tier lands Phase 6), so the degraded node's
	// "only two-player rooms" rule is proven with slots 3 (>2, still valid).
	assert.equal((await f.request('POST', { map: 'a'.repeat(40), slots: 3, name: 'fixture' })).status, 503);
	const response = await f.request('POST', { map: 'a'.repeat(40), slots: 2, name: 'fixture' });
	assert.equal(response.status, 201);
	assert.deepEqual((await f.request('GET')).body.rooms.map(r => r.roomId), [response.body.room.roomId]);
});

test('healthy node admits rooms', async t => {
	const f = await fixture(t, 0, 1024 * MiB, { healthy: true, degraded: false });
	const response = await f.request('POST', { map: 'a'.repeat(40), slots: 2, name: 'fixture' });
	assert.equal(response.status, 201);
	assert.deepEqual((await f.request('GET')).body.rooms.map(r => r.roomId), [response.body.room.roomId]);
	const drain = await f.request('POST', {}, '/v2/drain');
	assert.equal(drain.status, 200);
	assert.equal((await f.request('POST', { map: 'a'.repeat(40), slots: 2, name: 'late room' })).status, 503);
});

test('donate node drains and exits when no room is active', async t => {
	const f = await fixture(t, 0, 1024 * MiB, { healthy: true, degraded: false });
	const response = await f.request('POST', {}, '/v2/drain');
	assert.equal(response.status, 200);
	assert.equal(response.body.draining, true);
	assert.equal(response.body.freeMatches, 0);
	assert.equal(await f.waitForExit(), 0);
});

test('a standing node drains its empty community lobby and exits', async t => {
	const f = await fixture(t, 0, 1024 * MiB, { healthy: true, degraded: false }, { standing: true, exitOnDrain: true });
	const deadline = Date.now() + 5000;
	let rooms;
	do {
		rooms = (await f.request('GET')).body.rooms;
		if (rooms.length === 1 && rooms[0].state === 'lobby') break;
		await delay(50);
	} while (Date.now() < deadline);
	assert.equal(rooms?.[0]?.state, 'lobby');
	const drain = await f.request('POST', {}, '/v2/drain');
	assert.equal(drain.status, 200);
	assert.equal(await f.waitForExit(), 4);
});
