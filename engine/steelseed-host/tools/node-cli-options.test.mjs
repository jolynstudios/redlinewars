import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildOptions } from './node-cli.mjs';

test('node CLI forwards the explicit data directory to the shared room host', t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-node-cli-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const options = buildOptions([
		'--mode', 'donate',
		'--data-dir', root,
		'--spine', 'ws://127.0.0.1:13601/node',
		'--ws', '14712', '--http', '14713', '--base-port', '14800',
	], { REDLINE_NODE_KEY: 'a'.repeat(64) });

	assert.equal(options.dataDir, root);
	assert.equal(options.nodeKeyFile, path.join(root, 'node.key'));
	assert.ok(fs.existsSync(options.nodeKeyFile));
	assert.equal(options.muxPort, 14712);
	assert.equal(options.httpPort, 14713);
	assert.equal(options.basePort, 14800);
	assert.equal(options.exitOnDrain, undefined);
});

test('systemd nodes can stop cleanly after drain without desktop changing its exit code', t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-node-drain-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const options = buildOptions(['--mode', 'donate', '--data-dir', root, '--exit-on-drain'], {
		REDLINE_NODE_KEY: 'c'.repeat(64),
	});
	assert.equal(options.exitOnDrain, true);
});

test('DATA_DIR follows the same single-entry-point contract', t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-node-env-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const options = buildOptions([], {
		MODE: 'donate',
		DATA_DIR: root,
		REDLINE_NODE_KEY: 'b'.repeat(64),
	});

	assert.equal(options.dataDir, root);
});

// ---- zero-config defaults (the community zip starts with no arguments) ----

const PRODUCTION_SPINE = 'wss://spine.redlinewars.online/node';

function packageFixture(t, { rooms = false, example = false } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-node-pkg-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	if (rooms) fs.copyFileSync(new URL('./rooms.example.json', import.meta.url), path.join(root, 'rooms.json'));
	if (example) fs.copyFileSync(new URL('./rooms.example.json', import.meta.url), path.join(root, 'rooms.example.json'));
	return root;
}

test('zero arguments: standing mode reads rooms.json from the working directory and defaults to the production spine', t => {
	const cwd = packageFixture(t, { rooms: true });
	const empty = packageFixture(t);
	const options = buildOptions([], { DATA_DIR: cwd, REDLINE_NODE_KEY: 'd'.repeat(64) }, {
		cwd, packageRoot: empty, hostname: 'Test-Host',
	});

	assert.equal(options.mode, 'standing');
	assert.equal(options.roomsFile, path.join(cwd, 'rooms.json'));
	assert.equal(options.spineUrl, PRODUCTION_SPINE);
	assert.equal(fs.existsSync(path.join(empty, 'rooms.json')), false, 'the package root is not written when cwd has rooms.json');
});

test('first run copies rooms.example.json to rooms.json once, appending the machine hostname to every room name', t => {
	const cwd = packageFixture(t, { example: true });
	const runtime = { cwd, packageRoot: packageFixture(t), hostname: 'MacBook-Pro-2.local' };
	const first = buildOptions([], { DATA_DIR: cwd, REDLINE_NODE_KEY: 'e'.repeat(64) }, runtime);

	assert.equal(first.roomsFile, path.join(cwd, 'rooms.json'));
	const created = JSON.parse(fs.readFileSync(path.join(cwd, 'rooms.json'), 'utf8'));
	assert.equal(created.rooms.length, 1);
	assert.equal(created.rooms[0].name, 'Community #1 (MacBook-Pro-2)');
	assert.deepEqual(created.rooms[0].maps, ['af68f5f539b2717234b48d7fd687d3a6ae9cc916']);
	assert.equal(fs.existsSync(path.join(cwd, 'rooms.example.json')), true, 'the example stays for reference');

	// The copy happens ONCE: a second start (even under another hostname)
	// must not touch an edited rooms.json.
	fs.writeFileSync(path.join(cwd, 'rooms.json'), JSON.stringify({ schema: 1, rooms: [{ name: 'Renamed', slots: 4, password: '', maps: [], settings: {} }] }));
	const second = buildOptions([], { DATA_DIR: cwd, REDLINE_NODE_KEY: 'e'.repeat(64) }, { ...runtime, hostname: 'Other-Host' });
	assert.equal(second.roomsFile, path.join(cwd, 'rooms.json'));
	assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, 'rooms.json'), 'utf8')).rooms[0].name, 'Renamed');
});

test('first-run room names respect the 32-character room-name cap roomhost enforces', t => {
	const cwd = packageFixture(t, { example: true });
	const options = buildOptions([], { DATA_DIR: cwd, REDLINE_NODE_KEY: '6'.repeat(64) }, {
		cwd, packageRoot: cwd, hostname: 'MacBook-Pro-van-Danillo',
	});

	const created = JSON.parse(fs.readFileSync(options.roomsFile, 'utf8'));
	assert.ok(created.rooms[0].name.length <= 32);
	assert.ok(created.rooms[0].name.startsWith('Community #1'));
	assert.ok(created.rooms[0].name.includes('MacBook-Pro-van-D'));
});

test('rooms.json missing in the working directory falls back to the package root (and can seed from its example)', t => {
	const pkg = packageFixture(t, { example: true });
	const options = buildOptions([], { DATA_DIR: pkg, REDLINE_NODE_KEY: 'f'.repeat(64) }, {
		cwd: packageFixture(t), packageRoot: pkg, hostname: 'VPS-1',
	});

	assert.equal(options.roomsFile, path.join(pkg, 'rooms.json'));
	assert.equal(JSON.parse(fs.readFileSync(options.roomsFile, 'utf8')).rooms[0].name, 'Community #1 (VPS-1)');
});

test('no rooms file anywhere fails with a helpful message', t => {
	const cwd = packageFixture(t);
	assert.throws(
		() => buildOptions([], { DATA_DIR: cwd, REDLINE_NODE_KEY: '1'.repeat(64) }, { cwd, packageRoot: cwd, hostname: 'x' }),
		/rooms\.example\.json.*--rooms-file/s,
	);
});

test('--lan opts back into a LAN-only standing node: no spine default, and the flag is not forwarded to the standing host', t => {
	const cwd = packageFixture(t, { rooms: true });
	const options = buildOptions(['--lan'], { DATA_DIR: cwd, REDLINE_NODE_KEY: '2'.repeat(64) }, {
		cwd, packageRoot: cwd, hostname: 'x',
	});

	assert.equal(options.spineUrl, null);
	assert.equal(options.lan, undefined);
});

test('an explicit --spine beats both --lan and the SPINE_URL environment default', t => {
	const cwd = packageFixture(t, { rooms: true });
	const runtime = { cwd, packageRoot: cwd, hostname: 'x' };

	const explicit = buildOptions(['--spine', 'ws://127.0.0.1:13601/node'], { DATA_DIR: cwd, REDLINE_NODE_KEY: '3'.repeat(64) }, runtime);
	assert.equal(explicit.spineUrl, 'ws://127.0.0.1:13601/node');

	const explicitWithLan = buildOptions(['--lan', '--spine', 'ws://127.0.0.1:13601/node'], { DATA_DIR: cwd, REDLINE_NODE_KEY: '3'.repeat(64) }, runtime);
	assert.equal(explicitWithLan.spineUrl, 'ws://127.0.0.1:13601/node');

	const fromEnv = buildOptions([], { DATA_DIR: cwd, SPINE_URL: 'ws://127.0.0.1:13602/node', REDLINE_NODE_KEY: '3'.repeat(64) }, runtime);
	assert.equal(fromEnv.spineUrl, 'ws://127.0.0.1:13602/node');

	const lanBeatsEnv = buildOptions(['--lan'], { DATA_DIR: cwd, SPINE_URL: 'ws://127.0.0.1:13602/node', REDLINE_NODE_KEY: '3'.repeat(64) }, runtime);
	assert.equal(lanBeatsEnv.spineUrl, null);
});

test('an explicit --rooms-file wins over the defaulting and is used as given', t => {
	const cwd = packageFixture(t); // neither rooms.json nor rooms.example.json
	const custom = path.join(cwd, 'my-rooms.json');
	fs.writeFileSync(custom, JSON.stringify({ schema: 1, rooms: [] }));
	const options = buildOptions(['--rooms-file', custom], { DATA_DIR: cwd, REDLINE_NODE_KEY: '4'.repeat(64) }, {
		cwd, packageRoot: cwd, hostname: 'x',
	});

	assert.equal(options.roomsFile, custom);
});

test('desktop keeps its exact command line: --mode own --lan stays LAN-visible with no spine', t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-node-desktop-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const options = buildOptions(['--mode', 'own', '--lan', '--data-dir', root], { REDLINE_NODE_KEY: '5'.repeat(64) });
	assert.equal(options.mode, 'own');
	assert.equal(options.spineUrl, null, 'the desktop LAN host must not inherit the production spine default');
	assert.equal(options.lan, true);
	assert.equal(options.roomsFile, undefined, 'own mode never triggers the rooms-file defaulting');
});
