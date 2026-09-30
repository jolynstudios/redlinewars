import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { makeNodeTree, reservePort } from './roomhost-fixture.mjs';

test('roomhost directory invites preserve query and resolve shared relative assets', { timeout: 15_000 }, async t => {
	const fx = await makeNodeTree(t, { mode: 'idle' });
	let child;
	let log = '';
	t.after(async () => {
		try { await stopProcessGroup(child); }
		finally { await fx.cleanup(); }
	});
	// A tiny static fixture is sufficient; no game build or dedicated process.
	const bundle = path.join(fx.dir, 'AppBundle');
	await fs.mkdir(path.join(bundle, 'steelseed/assets'), { recursive: true });
	await fs.writeFile(path.join(bundle, 'main.js'), 'engine-fixture');
	await fs.writeFile(path.join(bundle, 'steelseed/assets/game-sample.js'), 'presentation-fixture');
	const html = '<script type="module" src="../main.js"></script><script type="module" src="./assets/game-sample.js"></script>';
	await fs.writeFile(path.join(bundle, 'steelseed/index.html'), html);
	const reserved = await reservePort();
	await reserved.release();
	child = spawnProcessGroup(process.execPath, [path.join(fx.dir, 'steelseed-host/tools/roomhost.mjs'),
		'--bundle', bundle, '--http', String(reserved.port), '--ws', '0', '--data-dir', fx.dataDir], {
		stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...fx.runnerEnv, REDLINE_NODE_KEY: fx.key },
	});
	child.stdout.on('data', data => { log += data; });
	child.stderr.on('data', data => { log += data; });
	const end = Date.now() + 5000;
	while (!log.includes('[roomhost] directory')) {
		assert.equal(child.exitCode, null, log);
		assert.ok(Date.now() < end, `roomhost did not listen: ${log}`);
		await delay(25);
	}
	const origin = `http://127.0.0.1:${reserved.port}`;
	const invite = `${origin}/steelseed?room=a1b2c3&debug=on`;
	const redirect = await fetch(invite, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
	assert.equal(redirect.status, 308);
	assert.equal(redirect.headers.get('location'), '/steelseed/?room=a1b2c3&debug=on');
	assert.equal(redirect.headers.get('cache-control'), 'no-store');
	await redirect.arrayBuffer();
	const response = await fetch(invite, { signal: AbortSignal.timeout(3000) });
	assert.equal(response.status, 200);
	assert.equal(response.url, `${origin}/steelseed/?room=a1b2c3&debug=on`);
	assert.equal(await response.text(), html);
	for (const [relative, expected] of [['../main.js', 'engine-fixture'], ['./assets/game-sample.js', 'presentation-fixture']]) {
		const asset = await fetch(new URL(relative, response.url), { signal: AbortSignal.timeout(3000) });
		assert.equal(asset.status, 200);
		assert.equal(await asset.text(), expected);
	}
	const explicit = await fetch(`${origin}/steelseed/index.html?room=a1b2c3`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
	assert.equal(explicit.status, 200);
	assert.equal(explicit.headers.get('location'), null);
	assert.equal(await explicit.text(), html);
	const traversal = await fetch(`${origin}/%2e%2e%2fprivate`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
	assert.equal(traversal.status, 403);
	await traversal.arrayBuffer();
});
