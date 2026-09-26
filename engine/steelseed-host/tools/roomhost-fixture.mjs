// Test fixture for the node (T1.1): a minimal standalone node tree in a
// tmpdir. The node spawns the dedicated server DIRECTLY now, so unit tests
// ship a fake `bin-standalone/<rid>/OpenRA.Server` instead of the real engine:
//
//   mode 'echo': the fake dedicated listens on its Server.ListenPort and pipes
//                bytes back (exercises the pump roundtrip and prints
//                `notification-joined` so the room reaches `lobby`).
//   mode 'idle': the fake dedicated only stays alive (rooms stay `booting`).
//
// The tree carries copies of the node sources and a tiny map catalog so
// T1.10 validation accepts the fixture uid. `key` is the node API key the
// tests pass via REDLINE_NODE_KEY and the x-redline-node-key header.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(toolsDir, '../..');

const RID_MAP = {
	'darwin-arm64': 'osx-arm64',
	'darwin-x64': 'osx-x64',
	'win32-x64': 'win-x64',
	'win32-arm64': 'win-x64',
	'linux-x64': 'linux-x64',
	'linux-arm64': 'linux-arm64',
};

const RUNNER_MODES = {
	echo: `#!/usr/bin/env node
// Fixture dedicated server: listens on Server.ListenPort, echoes bytes.
const net = require('node:net');
const fs = require('node:fs');
const arg = name => (process.argv.find(a => a.startsWith(name + '=')) || '').slice(name.length + 1);
const port = Number(arg('Server.ListenPort'));
const supportDir = arg('Engine.SupportDir');
try { fs.mkdirSync(supportDir, { recursive: true }); } catch {}
try { fs.writeFileSync(require('node:path').join(supportDir, 'fixture.pid'), String(process.pid)); } catch {}
net.createServer(socket => socket.pipe(socket)).listen(port, '127.0.0.1', () => {
	// The real engine prints notification-joined when a player joins, i.e.
	// well AFTER the listen socket exists — mirror that ordering so the
	// reserved -> lobby transition is observable. 1.5 s keeps it comfortably
	// behind the node's 500 ms accept-probe tick (booting -> reserved first).
	setTimeout(() => console.log('notification-joined'), 1500);
});
setInterval(() => {}, 10_000);
`,
	idle: `#!/usr/bin/env node
// Fixture dedicated server: stays alive without listening (rooms stay booting).
setInterval(() => {}, 10_000);
`,
};

export function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.once('listening', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
		server.listen(0, '127.0.0.1');
	});
}

// Reserve a port the kernel assigned while THIS process holds the socket —
// concurrent test files cannot steal it. release() right before the child
// binds, keeping the free-again window microscopic.
export async function reservePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const port = server.address().port;
	return {
		port,
		release: () => new Promise(resolve => server.close(resolve)),
	};
}

export async function makeNodeTree(_t, { mode = 'echo', players = 8, speeds = ['default', 'slowest', 'slower', 'normal', 'fast', 'faster'] } = {}) {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `node-fixture-${mode}-`));
	const tools = path.join(dir, 'steelseed-host/tools');

	await fs.promises.mkdir(tools, { recursive: true });
	// Copies, not symlinks: the entry-point guard compares process.argv[1]
	// with import.meta.url, and Node resolves symlinked module URLs to their
	// real path — a symlinked roomhost.mjs would never match and exit 0.
	// lan-beacon.mjs: roomhost.mjs imports it (--lan announcer), so the
	// copied tree must carry the whole import chain.
	for (const name of ['roomhost.mjs', 'relay-flow.mjs', 'placement-policy.mjs', 'dedicated-runner.mjs', 'lan-beacon.mjs', 'protocol.json', 'ranked-replay.mjs', 'ranked-claims.mjs', 'ranked-binding.mjs'])
		await fs.promises.copyFile(path.join(toolsDir, name), path.join(tools, name));
	// The whole engine node_modules tree, so `import 'ws'` resolves exactly
	// as it does in the repo.
	await fs.promises.symlink(path.join(engineRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

	const rid = RID_MAP[`${process.platform}-${process.arch}`];
	const binDir = path.join(dir, 'bin-standalone', rid);
	await fs.promises.mkdir(binDir, { recursive: true });
	const runner = path.join(binDir, process.platform === 'win32' ? 'OpenRA.Server.exe' : 'OpenRA.Server');
	await fs.promises.writeFile(runner, RUNNER_MODES[mode] ?? RUNNER_MODES.idle, { mode: 0o755 });
	const fixtureRunner = path.join(dir, 'fixture-server.cjs');
	await fs.promises.writeFile(fixtureRunner, RUNNER_MODES[mode] ?? RUNNER_MODES.idle, { mode: 0o755 });

	const generated = path.join(dir, 'steelseed-host/generated/mods/ra');
	await fs.promises.mkdir(generated, { recursive: true });
	const mapUid = 'a'.repeat(40);
	const catalog = [{ uid: mapUid, title: 'Fixture Town', players, speeds }];
	await fs.promises.writeFile(path.join(generated, 'map-catalog.json'), JSON.stringify(catalog, null, '\t'));
	await fs.promises.writeFile(path.join(generated, 'gate-map.json'), JSON.stringify(catalog[0], null, '\t'));

	const dataDir = path.join(dir, 'data');
	const key = crypto.randomBytes(32).toString('base64url');
	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		// Belt and braces: stop any fixture runner the node's own shutdown did
		// not reach, then drop the tree.
		try {
			for (const entry of fs.readdirSync(path.join(dataDir, 'rooms'))) {
				try {
					const pid = Number(fs.readFileSync(path.join(dataDir, 'rooms', entry, 'fixture.pid'), 'utf8').trim());
					if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
				} catch { /* no pidfile or already gone */ }
			}
		} catch { /* no rooms directory */ }
		await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	};
	return {
		dir, dataDir, key, mapUid, players, speeds, runner,
		runnerEnv: { REDLINE_NODE_FIXTURE_RUNNER: '1' },
		cleanup,
	};
}
