import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the shared server preserves directory links, relative assets and static contracts', async t => {
	const temp = await mkdtemp(path.join(tmpdir(), 'redline-static-server-'));
	const root = path.join(temp, 'AppBundle');
	await mkdir(path.join(root, 'steelseed/assets'), { recursive: true });
	await writeFile(path.join(root, 'steelseed/index.html'), '<script src="../main.js"></script><script src="./assets/game-12345678.js"></script>');
	await writeFile(path.join(root, 'main.js'), 'globalThis.host = true;');
	await writeFile(path.join(root, 'steelseed/assets/game-12345678.js'), 'globalThis.game = true;');
	await writeFile(path.join(root, 'runtime.wasm'), 'wasm-fixture');
	await writeFile(path.join(temp, 'private.txt'), 'outside bundle');
	const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--root', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
	t.after(async () => {
		if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
		await rm(temp, { recursive: true, force: true });
	});
	const base = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
		child.once('error', error => { clearTimeout(timer); reject(error); });
		child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
		let output = '';
		child.stdout.on('data', bytes => {
			output += bytes;
			const match = /at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
			if (match) { clearTimeout(timer); resolve(match[1]); }
		});
	});
	const directory = await fetch(new URL('steelseed?join=room-1&debug=on', base), { redirect: 'manual' });
	assert.equal(directory.status, 308);
	assert.equal(directory.headers.get('location'), '/steelseed/?join=room-1&debug=on');
	assert.equal(directory.headers.get('cache-control'), 'no-store');
	const page = await fetch(new URL('steelseed?join=room-1', base));
	assert.equal(page.status, 200);
	assert.equal(new URL(page.url).search, '?join=room-1');
	assert.match(page.headers.get('content-type'), /text\/html/);
	assert.equal(page.headers.get('cache-control'), 'no-store');
	assert.equal(await (await fetch(new URL('../main.js', page.url))).text(), 'globalThis.host = true;');
	const asset = await fetch(new URL('./assets/game-12345678.js', page.url));
	assert.equal(asset.status, 200);
	assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
	assert.equal((await fetch(new URL('runtime.wasm', base))).headers.get('content-type'), 'application/wasm');
	assert.equal((await fetch(new URL('steelseed/index.html', base))).status, 200);
	assert.equal((await fetch(new URL('steelseed/missing.js', base))).status, 404);
	assert.equal((await fetch(new URL('%2e%2e%2fprivate.txt', base))).status, 403);
});
