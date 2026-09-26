#!/usr/bin/env node
// T3.6 LAN listener — discovery runs here, in a child of the shell
// (`desktop/` is glue: it only starts/stops this process and forwards each
// output line to the page). Joins the beacon group on every non-internal
// IPv4 interface, sends a query at start and every 5 s, keeps entries for
// 10 s, and prints ONE JSON line whenever the visible set changes:
//
//   {"rooms":[{roomId,name,map,slots,players,state,locked,build,wsUrl}]}
//
// stdin: a `query` line sends a query now; `query <ip>` (or `<ip:port>`)
// sends a UNICAST query to that address. §5.7: the endpoint is built from
// the packet's SOURCE address, never from the payload; entries expire 10 s
// after the last announce; a room whose nodeId equals --self is dropped
// (the node's own rooms are already visible locally); at most 20 packets
// per second per source are processed.
//
//   node lan-listener.mjs [--self <nodeId>] [--loopback] [--target <ip[:port]>]…
//
// --loopback (discoverygate/CI): bind 127.0.0.1 on an ephemeral port and
// unicast queries to the --target addresses instead of multicasting.
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUP, PORT, encodeQuery, isPrivateAddress, parsePacket } from './lan-beacon.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const protocol = JSON.parse(fs.readFileSync(path.join(scriptDir, 'protocol.json'), 'utf8'));
const beacon = protocol.lanBeacon;

const argv = process.argv.slice(2);
const value = (name, fallback = null) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = name => argv.includes(name);
const selfNodeId = (value('--self') ?? '').toLowerCase();
const loopback = has('--loopback');
const parseEndpoint = text => {
	// The listener is udp4: an endpoint is a dotted quad with an optional
	// port (`query <ip>` / `query <ip:port>` / --target <ip[:port]>).
	const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(String(text ?? ''));
	if (!m) return null;
	const port = m[2] !== undefined ? Number(m[2]) : PORT;
	if (port < beacon.wsPortMin || port > beacon.wsPortMax) return null;
	return { address: m[1], port };
};
const targets = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] !== '--target' || argv[i + 1] === undefined) continue;
	const endpoint = parseEndpoint(argv[i + 1]);
	if (endpoint) targets.push(endpoint);
	i += 1;
}

// One entry per room endpoint: the same room announced over two interfaces
// refreshes one entry per source address, exactly the endpoints a joiner
// could dial. Entries expire expirySeconds after their last announce.
const entries = new Map(); // wsUrl -> entry
const rateBySource = new Map(); // source address -> [timestamps]
let lastEmitted = '';

function emitIfChanged() {
	const rooms = [...entries.values()]
		.sort((a, b) => a.wsUrl.localeCompare(b.wsUrl))
		.map(e => ({
			roomId: e.id,
			name: e.name,
			map: e.map,
			slots: e.slots,
			players: e.players,
			state: e.state,
			locked: e.locked,
			build: e.build,
			wsUrl: e.wsUrl,
		}));
	const line = JSON.stringify({ rooms });
	if (line === lastEmitted) return;
	lastEmitted = line;
	process.stdout.write(line + '\n');
}

function onPacket(buf, rinfo) {
	if (typeof rinfo?.address !== 'string') return;
	// §5.7: process at most 20 packets per second per source.
	const now = Date.now();
	const stamps = (rateBySource.get(rinfo.address) ?? []).filter(ts => now - ts < 1000);
	stamps.push(now);
	rateBySource.set(rinfo.address, stamps);
	if (stamps.length > beacon.ratePerSourcePerSecond) return;

	const packet = parsePacket(buf, rinfo);
	if (!packet) return;
	// The host already sees its own node's rooms — drop them.
	if (selfNodeId && packet.nodeId === selfNodeId) return;
	for (const room of packet.rooms) {
		const wsUrl = `ws://${packet.source}:${packet.ws}/g/${room.id}`;
		entries.set(wsUrl, {
			id: room.id,
			name: room.name,
			map: room.map,
			slots: room.slots,
			players: room.players,
			state: room.state,
			locked: room.locked,
			build: packet.build,
			wsUrl,
			lastSeen: now,
		});
	}
	emitIfChanged();
}

function sendQuery(target) {
	const payload = encodeQuery();
	if (target) socket.send(payload, target.port, target.address, () => { /* best effort */ });
	else if (loopback) for (const t of targets) socket.send(payload, t.port, t.address, () => { /* best effort */ });
	else socket.send(payload, PORT, GROUP, () => { /* best effort */ });
}

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
socket.on('message', onPacket);
socket.on('error', err => {
	console.error(`[lan-listener] socket error: ${err.message}`);
});

// Group membership on every non-internal IPv4 interface, re-enumerated on
// the §5.7 cadence (new networks, sleep/wake).
let members = [];
function refreshInterfaces() {
	if (loopback) return;
	const seen = new Set();
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const addr of addrs ?? []) {
			if (addr.family !== 'IPv4' || addr.internal) continue;
			seen.add(addr.address);
			if (members.includes(addr.address)) continue;
			try { socket.addMembership(GROUP, addr.address); } catch { /* best effort */ }
		}
	}
	members = [...seen];
}

socket.bind(loopback ? 0 : PORT, loopback ? '127.0.0.1' : undefined, () => {
	if (!loopback) {
		try { socket.setMulticastTTL(protocol.ports.lanBeaconTtl); } catch { /* not fatal */ }
		refreshInterfaces();
	}
	sendQuery();
});

// Query at start and every 5 s (§5.7).
const queryTimer = setInterval(() => sendQuery(), beacon.queryEverySeconds * 1000);
queryTimer.unref();
let ifaceTimer = null;
if (!loopback) {
	ifaceTimer = setInterval(refreshInterfaces, beacon.ifaceEverySeconds * 1000);
	ifaceTimer.unref();
}

// Entries expire 10 s after the last announce (§5.7).
const expiryTimer = setInterval(() => {
	const cutoff = Date.now() - beacon.expirySeconds * 1000;
	let changed = false;
	for (const [wsUrl, entry] of entries) {
		if (entry.lastSeen >= cutoff) continue;
		entries.delete(wsUrl);
		changed = true;
	}
	if (changed) emitIfChanged();
}, 500);
expiryTimer.unref();

// stdin: `query` sends a query now; `query <ip[:port]>` unicasts to that
// address (T3.7's "enter address" path).
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
	for (const rawLine of String(chunk).split('\n')) {
		const line = rawLine.trim();
		if (!line.startsWith('query')) continue;
		const arg = line.slice('query'.length).trim();
		if (!arg) {
			sendQuery();
			continue;
		}
		const endpoint = parseEndpoint(arg);
		if (!endpoint || !isPrivateAddress(endpoint.address)) continue;
		sendQuery(endpoint);
	}
});
process.stdin.on('end', () => { /* the shell keeps our stdin open */ });
const shutdown = () => {
	try { socket.close(); } catch { /* already closed */ }
	process.exit(0);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
