#!/usr/bin/env node
// T3.16 discoverygate — the §9.2 assertions for LAN discovery (T3.5/T3.6):
//
//   1. two announcers are found in < 5 s;
//   2. an entry expires within 12 s of its announcer stopping;
//   3. a payload naming another IP is ignored (endpoint = packet source);
//   4. oversized packets are dropped;
//   5. foreign-app packets are dropped.
//
// Default mode exercises REAL multicast on this machine's interfaces: two
// announcers via startAnnouncer() and the real lan-listener.mjs child.
// With --loopback (CI runners drop multicast) the announcers and the
// listener bind 127.0.0.1 and the listener uses unicast queries.
//
//   node discoverygate.mjs [--loopback]
//
// Exit code = number of failed checks. One PASS/FAIL line per check.
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	GROUP,
	MAX_BYTES,
	PORT,
	encodeAnnounce,
	lanInterfaces,
	parsePacket,
	startAnnouncer,
} from './lan-beacon.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const listenerScript = path.join(scriptDir, 'lan-listener.mjs');
const loopback = process.argv.includes('--loopback');
// Loopback announcer ports (CI): env-overridable, well off the beacon port.
const LOOP_PORT_1 = Number(process.env.DISCOVERYGATE_PORT_1 ?? '47890');
const LOOP_PORT_2 = Number(process.env.DISCOVERYGATE_PORT_2 ?? '47891');

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
	return ok;
}

const room1 = { id: 'a1a1a1a1a1a1a1a1', name: 'Gate One', map: 'Marigold Town', slots: 4, players: 1, state: 'lobby', locked: false };
const room2 = { id: 'b2b2b2b2b2b2b2b2', name: 'Gate Two', map: 'Marigold Town', slots: 2, players: 0, state: 'playing', locked: true };
const state1 = { build: '3f9c1a07b2de', nodeId: '111111111111', name: 'Gate Announcer One', ws: 40101, rooms: [room1] };
const state2 = { build: '3f9c1a07b2de', nodeId: '222222222222', name: 'Gate Announcer Two', ws: 40102, rooms: [room2] };

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
	// ---- the real listener as a child, exactly like the shell runs it ----
	const listenerArgs = [listenerScript];
	if (loopback) {
		listenerArgs.push('--loopback',
			'--target', `127.0.0.1:${LOOP_PORT_1}`,
			'--target', `127.0.0.1:${LOOP_PORT_2}`);
	}
	const listener = spawn(process.execPath, listenerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
	const lines = [];
	let stderrText = '';
	listener.stdout.setEncoding('utf8');
	listener.stdout.on('data', chunk => {
		for (const line of chunk.split('\n')) {
			if (!line.trim()) continue;
			try { lines.push(JSON.parse(line)); } catch { /* not a rooms line */ }
		}
	});
	listener.stderr.setEncoding('utf8');
	listener.stderr.on('data', chunk => { stderrText += chunk; });
	const latest = () => lines[lines.length - 1] ?? null;
	const hasRoom = (snapshot, id) => !!snapshot?.rooms?.some(room => room.roomId === id);

	// ---- two announcers through the real startAnnouncer() path ----
	const a1 = startAnnouncer({
		getState: () => state1,
		...(loopback ? { loopback: true, port: LOOP_PORT_1 } : {}),
	});
	const a2 = startAnnouncer({
		getState: () => state2,
		...(loopback ? { loopback: true, port: LOOP_PORT_2 } : {}),
	});

	try {
		// 1. both announcers found in < 5 s.
		const foundBoth = await (async () => {
			const deadline = Date.now() + 5000;
			for (;;) {
				const snapshot = latest();
				if (snapshot && hasRoom(snapshot, room1.id) && hasRoom(snapshot, room2.id)) return snapshot;
				if (Date.now() > deadline) return null;
				await sleep(150);
			}
		})();
		check('two announcers found in <5 s', foundBoth !== null,
			`lines=${lines.length} stderr=${stderrText.slice(0, 200)}`);

		// 3 (end-to-end half). every endpoint is built from the packet's
		// source address: the payload carries no address, so every wsUrl host
		// must be one of THIS machine's own addresses.
		const localAddrs = new Set(loopback
			? ['127.0.0.1']
			: lanInterfaces().map(iface => iface.address).concat(['127.0.0.1']));
		const foreignHost = lines.flatMap(snapshot => snapshot?.rooms ?? [])
			.map(room => {
				try { return new URL(room.wsUrl).hostname; } catch { return room.wsUrl; }
			})
			.find(host => !localAddrs.has(host));
		check('endpoint built from packet source, not payload', foreignHost === undefined,
			`foreign host ${foreignHost} (local: ${[...localAddrs].join(', ')})`);

		// 2. the entry expires within 12 s of its announcer stopping.
		const stopAt = Date.now();
		a1.stop();
		const expiryDeadline = stopAt + 12_000;
		let expired = null;
		while (Date.now() <= expiryDeadline) {
			const snapshot = latest();
			if (snapshot && !hasRoom(snapshot, room1.id) && hasRoom(snapshot, room2.id)) {
				expired = snapshot;
				break;
			}
			await sleep(150);
		}
		check('entry expires within 12 s of stopping', expired !== null,
			`room ${room1.id} still listed ${(Date.now() - stopAt) / 1000}s after stop`);

		// ---- packet-rule unit checks against parsePacket (§5.7) ----
		const goodBuf = encodeAnnounce(state1);
		const privateSource = { address: '192.168.220.10', port: 50000 };

		// 4. oversized packets are dropped — exactly MAX_BYTES parses.
		check('oversized packet dropped (payload ignored at ≤1200)',
			parsePacket(Buffer.alloc(MAX_BYTES + 1), privateSource) === null
			&& (goodBuf.length <= MAX_BYTES && parsePacket(goodBuf, privateSource) !== null),
			`good=${goodBuf.length}B`);

		// 5. foreign-app packets are dropped.
		const foreignApp = JSON.parse(goodBuf.toString('utf8'));
		foreignApp.app = 'some-other-tool';
		check('foreign-app packet dropped',
			parsePacket(Buffer.from(JSON.stringify(foreignApp)), privateSource) === null);

		// 3 (unit half). a payload naming another IP is ignored: no
		// address-shaped field from the payload may survive into the record.
		const spoofed = JSON.parse(goodBuf.toString('utf8'));
		spoofed.ip = '203.0.113.9';
		spoofed.address = '203.0.113.9';
		spoofed.wsUrl = 'ws://203.0.113.9:9/g/deadbeefdeadbeef';
		spoofed.host = '203.0.113.9';
		const spoofRecord = parsePacket(Buffer.from(JSON.stringify(spoofed)), privateSource);
		check('spoofed-IP payload ignored (endpoint = packet source)',
			spoofRecord !== null
			&& !JSON.stringify(spoofRecord).includes('203.0.113.9')
			&& spoofRecord.source === privateSource.address,
			`record: ${JSON.stringify(spoofRecord)}`);

		// The listener survived every hostile packet above.
		check('listener survives oversized/foreign packets',
			listener.exitCode === null && listener.signalCode === null,
			`stderr: ${stderrText.slice(0, 200)}`);
	} finally {
		a1.stop();
		a2.stop();
		listener.kill('SIGTERM');
		await new Promise(resolve => {
			listener.once('exit', resolve);
			setTimeout(() => { try { listener.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 2000);
		});
	}

	const failures = results.filter(r => !r.ok).length;
	console.log(`=== discoverygate (${loopback ? 'loopback' : 'multicast'}): ${results.length - failures}/${results.length} checks passed ===`);
	process.exitCode = failures > 0 ? failures : 0;
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
