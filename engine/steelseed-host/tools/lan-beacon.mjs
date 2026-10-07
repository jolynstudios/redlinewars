// T3.5 LAN announcer + the §5.7 packet rules both sides share. UDP, JSON,
// one packet ≤ 1200 bytes, multicast group 239.255.77.87:47877 (TTL 1) plus
// each interface's directed broadcast. The ANNOUNCER (started by
// roomhost.mjs with --lan) joins the group on every non-internal IPv4
// interface, announces every 2 s while at least one LAN-visible room is in
// lobby/playing, and answers every query with a unicast reply. The LISTENER
// (lan-listener.mjs) and this file share parsePacket(), which enforces every
// §5.7 listener rule.
//
// Payload (§5.7): {"v":1,"app":"redline","t":"announce","build":"<12 hex>",
//   "nodeId":"<12 hex>","name":"…","ws":14710,"rooms":[{id,name,map,slots,
//   players,state,locked}]}
// The payload NEVER carries an address: the listener builds the endpoint
// from the packet's source address (ws://<rinfo.address>:<ws>/g/<id>).
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// L11/L12/L13/L16/L17 constants live in protocol.json — no magic numbers here.
const protocol = JSON.parse(fs.readFileSync(path.join(scriptDir, 'protocol.json'), 'utf8'));
const beacon = protocol.lanBeacon;

export const GROUP = protocol.ports.lanMulticastGroup;
export const PORT = protocol.ports.lanBeaconUdp;
export const MAX_BYTES = beacon.maxBytes;

const ROOM_ID_RE = /^[0-9a-f]{16}$/;
const NODE_ID_RE = new RegExp(`^[0-9a-f]{1,${beacon.nodeIdMaxChars}}$`);
// §5.7 listener rule: the source must be private, link-local or loopback.
// IPv4 only — the beacon is a udp4 protocol (the multicast group and the
// directed broadcasts are IPv4 concepts).
export function isPrivateAddress(ip) {
	if (typeof ip !== 'string') return false;
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return false;
	const octets = m.slice(1).map(Number);
	if (octets.some(o => o > 255)) return false;
	const [a, b] = octets;
	if (a === 10) return true; // 10/8
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
	if (a === 192 && b === 168) return true; // 192.168/16
	if (a === 169 && b === 254) return true; // 169.254/16 link-local
	if (a === 127) return true; // 127/8 loopback
	return false;
}

// §5.2 string clamp: NFC-normalise, strip control characters, clamp length.
function clampText(value, max) {
	if (typeof value !== 'string') return '';
	return value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function dottedToInt(dotted) {
	const parts = String(dotted).split('.').map(Number);
	if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null;
	return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToDotted(n) {
	return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// The interface's directed broadcast address (address | ~netmask, §5.7).
function directedBroadcast(iface) {
	const ip = dottedToInt(iface.address);
	const mask = dottedToInt(iface.netmask);
	if (ip === null || mask === null) return null;
	return intToDotted((ip | (~mask >>> 0)) >>> 0);
}

// Non-internal IPv4 interfaces, re-enumerated by the callers every
// ifaceEverySeconds (§5.7).
export function lanInterfaces() {
	const out = [];
	for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
		for (const addr of addrs ?? []) {
			if (addr.family !== 'IPv4' || addr.internal) continue;
			const broadcast = directedBroadcast({ address: addr.address, netmask: addr.netmask });
			if (broadcast) out.push({ name, address: addr.address, netmask: addr.netmask, broadcast });
		}
	}
	return out;
}

// Build one announce packet. Rooms beyond the directory cap are cut, and a
// payload that still would not fit one packet sheds rooms until it does —
// an oversized packet would be dropped by every listener, so never send one.
export function encodeAnnounce(state) {
	const rooms = (Array.isArray(state?.rooms) ? state.rooms : [])
		.slice(0, protocol.limits.maxRoomsPerNode)
		.filter(room => room && ROOM_ID_RE.test(String(room.id ?? '')))
		.map(room => ({
			id: String(room.id),
			name: clampText(room.name, beacon.nameMaxChars),
			map: clampText(room.map, beacon.nameMaxChars),
			slots: Number(room.slots),
			players: Number(room.players),
			state: room.state,
			locked: room.locked === true,
		}));
	const packet = {
		v: beacon.v,
		app: beacon.app,
		t: 'announce',
		build: clampText(state?.build, 12),
		nodeId: clampText(state?.nodeId, beacon.nodeIdMaxChars),
		name: clampText(state?.name, protocol.nodeTunnel.nodeNameMaxChars),
		ws: state?.ws,
		rooms,
	};
	while (Buffer.byteLength(JSON.stringify(packet)) > MAX_BYTES && packet.rooms.length > 0)
		packet.rooms.pop();
	if (Buffer.byteLength(JSON.stringify(packet)) > MAX_BYTES || !Number.isInteger(packet.ws))
		return null;
	return Buffer.from(JSON.stringify(packet));
}

export function encodeQuery() {
	return Buffer.from(JSON.stringify({ v: beacon.v, app: beacon.app, t: 'query' }));
}

// Every §5.7 listener rule in one place. Returns a normalised announce
// record (with `source` = the packet's source address — the ONLY address the
// listener may trust) or null when the packet must be dropped. Address-like
// fields inside the payload are ignored: they never reach the result.
export function parsePacket(buf, rinfo) {
	if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_BYTES) return null;
	if (!rinfo || typeof rinfo.address !== 'string' || !isPrivateAddress(rinfo.address)) return null;
	let msg;
	try { msg = JSON.parse(buf.toString('utf8')); } catch { return null; }
	if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
	if (msg.v !== beacon.v || msg.app !== beacon.app || msg.t !== 'announce') return null;
	if (!Number.isInteger(msg.ws) || msg.ws < beacon.wsPortMin || msg.ws > beacon.wsPortMax) return null;
	if (!Array.isArray(msg.rooms) || msg.rooms.length > protocol.limits.maxRoomsPerNode) return null;
	const nodeId = clampText(msg.nodeId, beacon.nodeIdMaxChars);
	if (!NODE_ID_RE.test(nodeId)) return null;
	const rooms = [];
	for (const raw of msg.rooms) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
		if (typeof raw.id !== 'string' || !ROOM_ID_RE.test(raw.id)) continue;
		if (raw.state !== 'lobby' && raw.state !== 'playing') continue;
		if (!Number.isInteger(raw.slots) || raw.slots < protocol.nodeApi.slotsMin || raw.slots > protocol.nodeApi.slotsMaxOwnerTier) continue;
		if (!Number.isInteger(raw.players) || raw.players < 0 || raw.players > 255) continue;
		rooms.push({
			id: raw.id,
			name: clampText(raw.name, beacon.nameMaxChars),
			map: clampText(raw.map, beacon.nameMaxChars),
			slots: raw.slots,
			players: raw.players,
			state: raw.state,
			locked: raw.locked === true,
		});
	}
	return {
		build: clampText(msg.build, 12),
		nodeId,
		name: clampText(msg.name, protocol.nodeTunnel.nodeNameMaxChars),
		ws: msg.ws,
		rooms,
		source: rinfo.address,
	};
}

// The announcer side of §5.7. `getState()` returns
// {build, nodeId, name, ws, rooms:[…]} — roomhost.mjs feeds it the
// LAN-visible lobby/playing rooms only. Loopback mode (discoverygate/CI)
// binds 127.0.0.1 on the given port and only answers unicast queries; there
// is no multicast or broadcast on a loopback-only network.
export function startAnnouncer({ getState, loopback = false, port = PORT } = {}) {
	const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
	let members = [];
	let announceTimer = null;
	let ifaceTimer = null;
	let stopped = false;
	let logThrottle = 0;

	const logOnce = why => {
		if (Date.now() - logThrottle < 30_000) return;
		logThrottle = Date.now();
		console.log(`[lan-beacon] ${why}`);
	};

	const refreshInterfaces = () => {
		const next = loopback ? [] : lanInterfaces();
		for (const iface of next) {
			if (members.some(m => m.address === iface.address)) continue;
			try { socket.addMembership(GROUP, iface.address); } catch (err) {
				logOnce(`addMembership ${GROUP} on ${iface.address} failed: ${err.message}`);
			}
		}
		members = next;
	};

	const sendTo = (payload, address, port_) => {
		socket.send(payload, port_, address, err => {
			if (err && err.code !== 'EMSGSIZE') logOnce(`send to ${address}:${port_} failed: ${err.message}`);
		});
	};

	const announceTick = () => {
		if (stopped || loopback) return;
		// §5.7: announce only while at least one LAN-visible room exists.
		const state = typeof getState === 'function' ? getState() : null;
		if (!state?.rooms?.length) return;
		const payload = encodeAnnounce(state);
		if (!payload) return;
		for (const iface of members) {
			// Multicast once per interface (TTL 1) …
			try { socket.setMulticastInterface(iface.address); } catch (err) {
				logOnce(`setMulticastInterface ${iface.address} failed: ${err.message}`);
			}
			sendTo(payload, GROUP, PORT);
			// … and once to the interface's directed broadcast address.
			sendTo(payload, iface.broadcast, PORT);
		}
	};

	socket.on('message', (buf, rinfo) => {
		// A query is answered with a unicast announce to the querier.
		let query;
		try { query = JSON.parse(buf.toString('utf8')); } catch { return; }
		if (!query || query.v !== beacon.v || query.app !== beacon.app || query.t !== 'query') return;
		const payload = encodeAnnounce(typeof getState === 'function' ? getState() : null);
		if (payload) socket.send(payload, rinfo.port, rinfo.address, () => { /* best effort */ });
	});
	socket.on('error', err => logOnce(`socket error: ${err.message}`));
	socket.bind(port, loopback ? '127.0.0.1' : undefined, () => {
		try {
			socket.setMulticastTTL(protocol.ports.lanBeaconTtl);
			// The second send per interface goes to the directed broadcast
			// address (§5.7) — that needs SO_BROADCAST.
			socket.setBroadcast(true);
		} catch { /* not fatal */ }
		refreshInterfaces();
		announceTick();
	});
	announceTimer = setInterval(announceTick, beacon.announceEverySeconds * 1000);
	announceTimer.unref();
	ifaceTimer = setInterval(refreshInterfaces, beacon.ifaceEverySeconds * 1000);
	ifaceTimer.unref();

	return {
		port: loopback ? port : PORT,
		loopback,
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(announceTimer);
			clearInterval(ifaceTimer);
			try { socket.close(); } catch { /* already closed */ }
		},
	};
}
