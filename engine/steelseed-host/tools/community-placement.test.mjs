// W1–W3: community placement on the node side. A standing node takes
// relay-placed player rooms only behind --accept-placed (fail closed without
// it, slots capped at 5 with it), the registration advertises the opt-in, and
// the admin idle-demotion decision honours its exemptions.
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
import { parseArgv } from './roomhost.mjs';
import { buildArgs } from './dedicated-runner.mjs';

// A real standing node (fixture dedicated) behind a fake spine socket.
async function standingFixture(t, { acceptPlaced = true, mode = 'standing', wait = true, fixture = 'echo' } = {}) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'community-placement-'));
	const fx = await makeNodeTree(t, { mode: fixture });
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
	await writeFile(path.join(dir, 'rooms.json'), JSON.stringify({
		schema: 1, rooms: [{ name: 'Community test', slots: 2, password: '', maps: [fx.mapUid], settings: { gamespeed: 'default', tod: 'auto', weather: 'on' } }],
	}));
	child = spawnProcessGroup(process.execPath, [`${fx.dir}/steelseed-host/tools/roomhost.mjs`,
		'--http', '0', '--ws', '0', '--spine', `ws://127.0.0.1:${spine.address().port}`,
		'--data-dir', fx.dataDir, '--idle-kill', '120',
		'--mode', mode,
		...(mode === 'standing' ? ['--rooms-file', path.join(dir, 'rooms.json')] : []),
		...(acceptPlaced ? ['--accept-placed'] : [])], {
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
	// `wait: false` is for tests that PROVE the node refuses to boot: there is
	// no register to wait for, only an exit code and the refusal line.
	if (wait) await until(() => messages.some(m => m.t === 'register'));
	async function createViaSpine(reqId, slots) {
		socket.send(JSON.stringify({ t: 'create', reqId, map: fx.mapUid, slots, name: `community ${reqId}` }));
		await until(() => messages.some(m => m.reqId === reqId));
		return messages.find(m => m.reqId === reqId);
	}
	// `log` is a string primitive: snapshotting it at return time would hand
	// the tests the empty pre-spawn value forever. Expose it live.
	return { messages, get log() { return log; }, until, createViaSpine, async waitForExit() {
		const deadline = Date.now() + 5000;
		while (child.exitCode === null && Date.now() < deadline) await delay(25);
		return child.exitCode;
	} };
}

test('a standing node registers the placement opt-in and serves placed rooms up to five seats', { timeout: 30000 }, async t => {
	const f = await standingFixture(t);
	const register = f.messages.find(m => m.t === 'register');
	assert.equal(register.mode, 'standing');
	assert.equal(register.acceptsPlaced, true, 'the opt-in must ride the registration');
	// Owner 2026-09-29: "5 players max though" — the community ceiling is five.
	assert.equal(register.placedSlotsMax, 5);
	const ok = await f.createViaSpine('placed-five', 5);
	assert.equal(ok.t, 'create-ok');
	assert.equal(ok.summary.slots, 5);
});

test('a placed room above the community ceiling is rejected, not clamped', { timeout: 30000 }, async t => {
	const f = await standingFixture(t);
	const refused = await f.createViaSpine('placed-six', 6);
	assert.equal(refused.t, 'create-fail');
	assert.equal(refused.error, 'invalid');
	assert.equal(refused.field, 'slots');
});

test('a standing node without --accept-placed fails every spine create closed', { timeout: 30000 }, async t => {
	const f = await standingFixture(t, { acceptPlaced: false });
	const register = f.messages.find(m => m.t === 'register');
	assert.equal('acceptsPlaced' in register, false, 'no opt-in is advertised without the flag');
	const refused = await f.createViaSpine('placed-closed', 2);
	assert.equal(refused.t, 'create-fail');
	assert.equal(refused.error, 'standing-mode');
});

test('--accept-placed outside standing mode refuses to start', { timeout: 20000 }, async t => {
	const f = await standingFixture(t, { acceptPlaced: true, mode: 'own', wait: false });
	assert.equal(await f.waitForExit(), 1);
	await delay(150); // the refusal line is stderr: let the pipe drain past 'exit'
	assert.match(f.log, /--accept-placed is a standing-mode flag/);
});

test('a creator whose join beats the accept probe still claims the placed room', { timeout: 30000 }, async t => {
	// Regression (community gate run 16): notification-joined used to claim a
	// placed room only from `reserved`. A fast creator's join lands while the
	// room is still `booting` (the spine routes their ws the moment create-ok
	// answers; the node's accept probe only ticks every 500 ms) — the claim was
	// dropped, the probe then set `reserved`, and the claim TTL killed the room
	// 90 s later with the creator connected to it. The eager fixture prints
	// notification-joined the instant its listen socket exists: that race,
	// deterministically. The claim must promote the room to `lobby` anyway.
	const f = await standingFixture(t, { fixture: 'eager' });
	const ok = await f.createViaSpine('eager-join', 2);
	assert.equal(ok.t, 'create-ok');
	await f.until(() => f.log.includes(`[room ${ok.roomId.slice(0, 6)}] state lobby`));
});

// Idle authority stays inside the same engine as the game, including LAN.
test('dedicated gets capacity, observer-first admission and authoritative idle policy', () => {
	const args = buildArgs({ name: 'test', port: 1234, map: 'a'.repeat(40), slots: 5, adminIdleSeconds: 600, settings: { tod: 'night', weather: 'on' } }, { engineRoot: '/fixture', supportDir: '/fixture/room' });
	for (const value of ['Server.LobbyCapacity=5', 'Server.ObserverFirstJoin=True', 'Server.AdminIdleTimeoutSeconds=600', 'Server.LobbyTimeOfDay=night', 'Server.LobbyWeather=on']) assert.ok(args.includes(value), value);
	assert.ok(buildArgs({map:'a',adminIdleSeconds:0}, {engineRoot:'/a',supportDir:'/b'}).includes('Server.AdminIdleTimeoutSeconds=0'));
});

// ---- argv surface ----

test('parseArgv carries the community flags', () => {
	const defaults = parseArgv([]);
	assert.equal(defaults.acceptPlaced, false);
	assert.equal(defaults.adminIdleSeconds, 600);
	const explicit = parseArgv(['--accept-placed', '--admin-idle-seconds', '0']);
	assert.equal(explicit.acceptPlaced, true);
	assert.equal(explicit.adminIdleSeconds, 0);
});
