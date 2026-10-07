// Live network status system test: boots the real spine as a child process,
// connects a fake node over the node tunnel, and asserts the public surfaces
// (/nodes, /events SSE frames, /network dashboard). Run from this directory:
//   node --test network-status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 14600;
const WS_PORT = 14601;
const NODE_KEY = Buffer.alloc(32, 7).toString('base64url'); // 43 base64url chars

function httpGet(pathname, { timeout = 5000 } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: '127.0.0.1', port: HTTP_PORT, path: pathname, timeout }, res => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', c => { body += c; });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error('http timeout')); });
	});
}

async function waitUntilReady() {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const res = await httpGet('/rooms', { timeout: 500 });
			if (res.status === 200) return;
		} catch { /* not up yet */ }
		await new Promise(r => setTimeout(r, 150));
	}
	throw new Error('spine did not become ready within 10 s');
}

function openEventStream() {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/events' }, res => {
			if (res.statusCode !== 200) { reject(new Error(`events status ${res.statusCode}`)); return; }
			let buf = '';
			const onData = c => {
				buf += c;
				const m = buf.match(/^data: (.+)\n/m);
				if (m) {
					res.removeListener('data', onData);
					resolve({ res, first: JSON.parse(m[1]), rawHead: buf });
				}
			};
			res.on('data', onData);
			res.on('error', reject);
		});
		req.on('error', reject);
	});
}

test('spine /nodes, /events SSE and /network with a live fake node', async () => {
	const spine = spawn(process.execPath, [path.join(scriptDir, 'spine.mjs'),
		'--http', String(HTTP_PORT), '--ws', String(WS_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
	let spineLog = '';
	spine.stdout.on('data', c => { spineLog += c; });
	spine.stderr.on('data', c => { spineLog += c; });
	try {
		await waitUntilReady();

		// The /network dashboard serves the styled page.
		const page = await httpGet('/network');
		assert.equal(page.status, 200);
		assert.match(page.headers['content-type'], /text\/html/);
		assert.ok(page.body.includes("EventSource('/events')"), 'dashboard subscribes to /events');
		assert.ok(page.body.includes('#08080D'), 'Twenty+One background token present');
		assert.ok(page.body.includes('F2A33C'), 'amber accent token present');

		// No node yet: totals are zero.
		let nodes = JSON.parse((await httpGet('/nodes')).body);
		assert.equal(nodes.length, 0);
		let stream = await openEventStream();
		assert.equal(stream.first.totals.nodes, 0);
		assert.equal(stream.first.totals.freeSlots, 0);
		assert.match(stream.rawHead, /retry: 3000/);
		stream.res.destroy();

		// Connect a fake node and register with protocol 2 (§5.5): no token,
		// identity = the per-install nodeKey. The reply selects the tier.
		const nodeWs = new WebSocket(`ws://127.0.0.1:${WS_PORT}/node`);
		await new Promise((resolve, reject) => { nodeWs.on('open', resolve); nodeWs.on('error', reject); });
		const registered = new Promise(resolve => nodeWs.on('message', data => {
			try { const msg = JSON.parse(String(data)); if (msg.t === 'registered') resolve(msg); } catch { /* not text */ }
		}));
		nodeWs.send(JSON.stringify({ t: 'register', proto: 2, nodeKey: NODE_KEY, build: 'testbuild001', mode: 'own', name: 'status fixture', maxMatches: 2, app: '0.0.0-test' }));
		const reg = await registered;
		assert.equal(reg.nodeId, crypto.createHash('sha256').update(NODE_KEY).digest('hex').slice(0, 12));
		assert.equal(reg.tier, 'community');
		assert.deepEqual(reg.caps, { channels: 16, rateBps: 65536, burst: 524288 });

		// /nodes reflects the registration.
		await new Promise(r => setTimeout(r, 300));
		nodes = JSON.parse((await httpGet('/nodes')).body);
		assert.equal(nodes[0].geo, ''); // protocol 2 registers carry no geo
		assert.equal(nodes[0].capacity, 2);

		// The next /events frame carries the node with its measured free slots.
		stream = await openEventStream();
		assert.equal(stream.first.totals.nodes, 1);
		assert.equal(stream.first.totals.freeSlots, 2);
		const frameNode = stream.first.nodes[0];
		assert.equal(frameNode.geo, ''); // protocol 2 registers carry no geo
		assert.equal(frameNode.freeMatches, 2);
		assert.equal(frameNode.healthy, true);
		assert.equal(frameNode.degraded, false);

		// A live status update from the node lands in the frames.
		const nextFrame = new Promise(resolve => {
			let buf = '';
			stream.res.on('data', c => {
				buf += c;
				for (const line of buf.split('\n')) {
					if (line.startsWith('data: ')) { resolve(JSON.parse(line.slice(6))); return; }
				}
			});
		});
		nodeWs.send(JSON.stringify({ t: 'status', freeMatches: 1, healthy: true, degraded: false, players: 3, maxPlayersPerMatch: 8, dedicatedRssBytes: 4096 }));
		const updated = await nextFrame;
		assert.equal(updated.totals.freeSlots, 1);
		assert.equal(updated.totals.players, 3);
		assert.equal(updated.nodes[0].freeMatches, 1);
		assert.equal(updated.nodes[0].players, 3);
		stream.res.destroy();

		// Protocol-level ws pings drive RTT now (the ws client auto-pongs);
		// the JSON ping/pong of protocol 1 is gone.
		const latencyFrame = await new Promise(async resolve => {
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline) {
				const s = await openEventStream();
				if (s.first.nodes[0]?.latencyMs !== null && s.first.nodes[0]?.latencyMs !== undefined) { s.res.destroy(); resolve(s.first); return; }
				s.res.destroy();
				await new Promise(r => setTimeout(r, 800));
			}
			resolve(null);
		});
		assert.ok(latencyFrame, 'latency never appeared in frames');
		assert.ok(Number.isFinite(latencyFrame.nodes[0].latencyMs));
		assert.ok(latencyFrame.nodes[0].latencyMs >= 0);

		// Closing the node flips the network to zero nodes in the next frame.
		nodeWs.close();
		await new Promise(r => setTimeout(r, 300));
		const gone = await openEventStream();
		assert.equal(gone.first.totals.nodes, 0);
		gone.res.destroy();

		// byGeo totals folded the disconnect (anonymous, geo only).
		assert.ok(gone.first.byGeo.some(g => g.geo === '' && g.reconnects >= 1), 'reconnect folded into byGeo');
	} finally {
		spine.kill('SIGKILL');
	}
});
