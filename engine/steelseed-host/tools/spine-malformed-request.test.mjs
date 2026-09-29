// OWASP regression: a request line Node's URL constructor rejects (`//[`,
// `http://[::1`) used to throw inside the spine's async http handler and its
// sync upgrade listener — no catch anywhere, process dead, every tunnel and
// match gone. The guards must answer 400 and the relay must stay alive.
// roomhost.mjs carries the identical guard on its own two parse sites; this
// file proves the class against the spine, whose ports a browser reaches.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import { reservePort } from './roomhost-fixture.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const spinePath = path.join(scriptDir, 'spine.mjs');

function httpJson(port, pathname) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, res => {
			let data = '';
			res.on('data', chunk => { data += chunk; });
			res.on('end', () => resolve({ status: res.statusCode }));
		});
		req.on('error', reject);
		req.end();
	});
}

async function startSpine(t) {
	const httpPort = await reservePort();
	const relayPort = await reservePort();
	await httpPort.release();
	await relayPort.release();
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-malformed-'));
	const config = path.join(configDir, 'relay.json');
	fs.writeFileSync(config, JSON.stringify({ placement: 'off', browserMultiplayer: 'off' }));
	const proc = spawnProcessGroup(process.execPath, [spinePath,
		'--http', String(httpPort.port), '--ws', String(relayPort.port), '--config', config],
		{ stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
	t.after(async () => {
		try { await stopProcessGroup(proc); } catch { /* already stopped */ }
		fs.rmSync(configDir, { recursive: true, force: true });
	});
	for (let i = 0; i < 100; i++) {
		try {
			if ((await httpJson(httpPort.port, '/v2/config')).status === 200) break;
		} catch { /* booting */ }
		await delay(50);
	}
	return { httpPort: httpPort.port, relayPort: relayPort.port, proc };
}

// One raw TCP request; resolves with the first response bytes (or '' when the
// peer just destroys the socket).
function rawRequest(port, payload) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(payload));
		const chunks = [];
		socket.on('data', c => { chunks.push(c); socket.destroy(); });
		socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
		socket.on('error', () => resolve(Buffer.concat(chunks).toString()));
		setTimeout(() => { socket.destroy(); reject(new Error('raw request timed out')); }, 5000).unref();
	});
}

// Verified against `new URL(p, base)` — every entry throws.
const BAD_PATHS = ['//[', 'http://[::1', '///[', 'http://[', '//'];
const GET = p => `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`;
const UPGRADE = p => `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;

test('malformed request lines get a 400 and never kill the relay (both ports)', { timeout: 60000 }, async t => {
	const spine = await startSpine(t);
	for (const bad of BAD_PATHS) {
		const httpAnswer = await rawRequest(spine.httpPort, GET(bad));
		assert.match(httpAnswer, /^HTTP\/1\.1 400/, `http port must answer 400 to ${JSON.stringify(bad)}, got: ${httpAnswer.slice(0, 40)}`);
		const wsAnswer = await rawRequest(spine.relayPort, UPGRADE(bad));
		assert.match(wsAnswer, /^HTTP\/1\.1 400/, `ws port upgrade must answer 400 to ${JSON.stringify(bad)}, got: ${wsAnswer.slice(0, 40)}`);
		// Alive after every shot: the directory still answers.
		assert.equal((await httpJson(spine.httpPort, '/v2/config')).status, 200, `spine died on ${JSON.stringify(bad)}`);
	}
	assert.equal(spine.proc.exitCode, null, 'the spine process must still be running');
});

test('the http guard also survives a malformed path without Host (HTTP/1.0)', { timeout: 30000 }, async t => {
	const spine = await startSpine(t);
	const answer = await rawRequest(spine.httpPort, 'GET //[ HTTP/1.0\r\n\r\n');
	assert.match(answer, /^HTTP\/1\.1 400/, answer.slice(0, 40));
	assert.equal((await httpJson(spine.httpPort, '/v2/config')).status, 200);
});
