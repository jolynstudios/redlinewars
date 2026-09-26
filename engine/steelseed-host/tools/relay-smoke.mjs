// relay-smoke — the four §9.2 assertions against a running relay (T4.4):
//
//   node relay-smoke.mjs [relayUrl] [wsUrl]
//     relayUrl  the relay's public base (default http://127.0.0.1:13600)
//     wsUrl     the ws base for /node and /g/*; defaults to relayUrl with
//               the scheme swapped — the same origin behind Caddy (§10.3).
//               A bare two-port spine needs it: relay-smoke http://…:13600 ws://…:13601
//
//   1 GET /v2/config has the §5.2 shape
//   2 a silent socket on /node is closed 4006 (no register within 5 s)
//   3 a player upgrade on /g/<unknown> is closed 4404 (room unknown)
//   4 no CORS headers are emitted for a foreign origin
//
// Prints exactly one PASS or FAIL line and exits non-zero on failure.
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

const relayUrl = process.argv[2] ?? 'http://127.0.0.1:13600';
const base = new URL(relayUrl);
const wsBase = process.argv[3] ?? `${base.protocol.replace(/^http/, 'ws')}//${base.host}`;
const httpBase = `${base.protocol}//${base.host}`;

function get(pathname, headers = {}) {
	return new Promise((resolve, reject) => {
		const transport = base.protocol === 'https:' ? https : http;
		const req = transport.get(`${httpBase}${pathname}`, { headers, timeout: 5000 }, res => {
			let body = '';
			res.on('data', c => { body += c; });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
		req.on('error', reject);
	});
}

// Resolves { code, reason } at the socket's close, or null after `ms`.
function closeOf(url, ms) {
	return new Promise(resolve => {
		let settled = false;
		const done = (code, reason) => {
			if (settled) return;
			settled = true;
			ws.terminate();
			resolve({ code, reason });
		};
		const ws = new WebSocket(url);
		ws.on('close', (code, reasonBuf) => done(code, reasonBuf.toString()));
		ws.on('error', () => { /* close follows */ });
		delay(ms).then(() => done(null, 'timeout'));
	});
}

const checks = [];
function check(name, ok, detail = '') {
	checks.push({ name, ok, detail });
}

// ---- 1 /v2/config shape (§5.2) ----
let config = null;
try {
	const res = await get('/v2/config');
	config = JSON.parse(res.body);
	check('config:status', res.status === 200, `status ${res.status}`);
	check('config:schema', config.schema === 1, `schema ${JSON.stringify(config.schema)}`);
	check('config:acceptedBuilds', Array.isArray(config.acceptedBuilds) && config.acceptedBuilds.every(b => typeof b === 'string'), JSON.stringify(config.acceptedBuilds));
	check('config:browserMultiplayer', ['off', 'join', 'full'].includes(config.browserMultiplayer), JSON.stringify(config.browserMultiplayer));
	check('config:placement', ['off', 'donated', 'donated+owner'].includes(config.placement), JSON.stringify(config.placement));
	check('config:draining', typeof config.draining === 'boolean', JSON.stringify(config.draining));
	check('config:app', typeof config.app === 'object' && config.app !== null
		&& typeof config.app.latest === 'string' && typeof config.app.downloadUrl === 'string', JSON.stringify(config.app));
} catch (e) {
	check('config:reachable', false, e.message);
}

// ---- 2 silent /node socket -> 4006 ----
const silent = await closeOf(`${wsBase}/node`, 10_000);
check('node:silent-4006', silent?.code === 4006, `close ${silent?.code ?? 'none'}`);

// ---- 3 /g/<unknown> -> 4404 ----
const unknownRoom = await closeOf(`${wsBase}/g/0000000000000000`, 5000);
check('room:unknown-4404', unknownRoom?.code === 4404, `close ${unknownRoom?.code ?? 'none'}`);

// ---- 4 CORS: foreign origin gets no headers; loopback origin is echoed ----
try {
	const foreign = await get('/v2/config', { origin: 'https://foreign.example' });
	check('cors:foreign-absent', foreign.headers['access-control-allow-origin'] === undefined,
		`access-control-allow-origin ${JSON.stringify(foreign.headers['access-control-allow-origin'])}`);
		const loopback = await get('/v2/config', { origin: `http://127.0.0.1:${base.port || (base.protocol === 'https:' ? '443' : '80')}` });
		check('cors:loopback-echo', loopback.headers['access-control-allow-origin'] === `http://127.0.0.1:${base.port || (base.protocol === 'https:' ? '443' : '80')}`,
		`access-control-allow-origin ${JSON.stringify(loopback.headers['access-control-allow-origin'])}`);
} catch (e) {
	check('cors:reachable', false, e.message);
}

const failed = checks.filter(c => !c.ok);
if (failed.length === 0) {
	console.log(`PASS relay-smoke ${httpBase} (${checks.length}/${checks.length} assertions)`);
	process.exitCode = 0;
} else {
	const first = failed[0];
	console.log(`FAIL relay-smoke ${httpBase} — ${first.name}: ${first.detail} (${checks.length - failed.length}/${checks.length} passed)`);
	process.exitCode = 1;
}
