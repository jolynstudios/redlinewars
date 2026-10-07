// T1.26 nodegate — the §9.2 assertions for the local node API, driven with
// Node's standard library ONLY: no browser, no GPU, no npm dependency. It
// starts roomhost.mjs with a temporary --data-dir and a generated
// REDLINE_NODE_KEY, exercises the hardened HTTP front door and a real room
// lifecycle over HTTP + TCP, asserts, and tears everything down.
//
//   node nodegate.mjs                       (ports via env, see below)
//
// Exit code = number of failed checks. One PASS/FAIL line per check.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const roomhostScript = path.join(toolsDir, 'roomhost.mjs');
// T1.27: the room's map is the generated mod's gate entry, never a literal.
const GATE = JSON.parse(fs.readFileSync(path.join(toolsDir, '../generated/mods/ra/gate-map.json'), 'utf8'));
// T3.19: standing-mode constants come from protocol.json like everywhere else.
const PROTOCOL = JSON.parse(fs.readFileSync(path.join(toolsDir, 'protocol.json'), 'utf8'));
// Full-system x64 emulation is much slower than native Linux. Scale only this
// gate's observation deadlines; the node's product timeouts stay unchanged.
const gateSlow = Number(process.env.REDLINE_GATE_SLOW ?? '1');
if (!Number.isInteger(gateSlow) || gateSlow < 1 || gateSlow > 10)
	throw new Error('REDLINE_GATE_SLOW must be an integer from 1 to 10');
const gateMs = ms => ms * gateSlow;

// Distinct port band so nodegate never collides with a concurrent browser
// gate (twoclient 134xx, shroud 134xx, desync 134xx, lan-ui 134xx).
const HTTP_PORT = Number(process.env.NODEGATE_HTTP ?? '13632');
const WS_PORT = Number(process.env.NODEGATE_WS ?? '13631');
const BASE_PORT = Number(process.env.NODEGATE_BASE ?? '13633');
const API = `127.0.0.1:${HTTP_PORT}`;
// T3.19 standing node: its own port band, never overlapping the baseline
// node above (the two phases never run concurrently, but keep them apart
// anyway so a hung baseline process cannot poison the standing phase).
const S_HTTP = Number(process.env.NODEGATE_S_HTTP ?? '13635');
const S_WS = Number(process.env.NODEGATE_S_WS ?? '13634');
const S_BASE = Number(process.env.NODEGATE_S_BASE ?? '13660');
const S_API = `127.0.0.1:${S_HTTP}`;

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
	return ok;
}

const jsonHeaders = key => ({
	'content-type': 'application/json',
	...(key ? { 'x-redline-node-key': key } : {}),
});

function request(method, pathname, { headers = {}, body = null, host = API } = {}) {
	return new Promise((resolve, reject) => {
		// The connection always dials the local node; `host` only sets the
		// Host header (that is exactly what the 421 misdirection probe needs,
		// and fetch() would forbid overriding Host).
		const req = http.request({ host: '127.0.0.1', port: HTTP_PORT, path: pathname, method, headers: { ...headers, host } }, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString();
				let json = null;
				try { json = JSON.parse(text); } catch { /* not json */ }
				resolve({ status: res.statusCode, json, text });
			});
		});
		req.on('error', reject);
		req.setTimeout(gateMs(10_000), () => req.destroy(new Error('request timeout')));
		if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
		req.end();
	});
}


function portAccepts(port, host = '127.0.0.1') {
	return new Promise(resolve => {
		const s = net.connect({ host, port });
		const done = ok => { s.destroy(); resolve(ok); };
		s.once('connect', () => done(true));
		s.once('error', () => done(false));
		s.setTimeout(2000, () => done(false));
	});
}

// First non-loopback IPv4 address of this machine, or null on a host without one.
function externalIPv4() {
	for (const address of Object.values(os.networkInterfaces()).flat())
		if (address?.family === 'IPv4' && !address.internal) return address.address;
	return null;
}

function processAlive(pid) {
	try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

async function poll(fn, timeoutMs, everyMs = 300) {
	const deadline = Date.now() + gateMs(timeoutMs);
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > deadline) return null;
		await new Promise(r => setTimeout(r, everyMs));
	}
}

// ---- boot the node ----
const nodeKey = crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodegate-'));
const logRing = [];
const roomhost = spawn(process.execPath, [
	roomhostScript,
	'--ws', String(WS_PORT), '--http', String(HTTP_PORT),
	'--base-port', String(BASE_PORT), '--max-matches', '1',
	'--idle-kill', '60',
	'--data-dir', dataDir,
], {
	stdio: ['ignore', 'pipe', 'pipe'],
	detached: process.platform !== 'win32',
	env: { ...process.env, REDLINE_NODE_KEY: nodeKey },
});
for (const stream of [roomhost.stdout, roomhost.stderr]) {
	stream.setEncoding('utf8');
	stream.on('data', chunk => {
		for (const line of chunk.split('\n')) {
			if (!line.trim()) continue;
			logRing.push(line);
			if (logRing.length > 400) logRing.shift();
		}
	});
}

async function statusJson() {
	try {
		const res = await request('GET', '/status.json');
		return res.status === 200 ? res.json : null;
	} catch { return null; }
}

let tempCleaned = false;
async function teardown() {
	if (roomhost.exitCode === null && roomhost.signalCode === null) {
		try { process.kill(-roomhost.pid, 'SIGTERM'); } catch { try { roomhost.kill('SIGTERM'); } catch { /* gone */ } }
	}
	await poll(() => roomhost.exitCode !== null || roomhost.signalCode !== null, 8000, 200);
	if (roomhost.exitCode === null && roomhost.signalCode === null) {
		try { process.kill(-roomhost.pid, 'SIGKILL'); } catch { try { roomhost.kill('SIGKILL'); } catch { /* gone */ } }
	}
	if (!tempCleaned) {
		fs.rmSync(dataDir, { recursive: true, force: true });
		tempCleaned = true;
	}
}

let fatal = null;
try {
	// 0. the node is up and its API answers.
	const up = await poll(statusJson, 20_000);
	check('roomhost reachable', up !== null, `no /status.json within 20 s\n${logRing.slice(-15).join('\n')}`);

	// 1. T1.9 Host pin: a request naming another host is misdirected (421).
	const hijacked = await request('GET', '/v2/health', { host: `evil.example:${HTTP_PORT}` });
	check('wrong Host -> 421', hijacked.status === 421, `got ${hijacked.status}`);

	// 2. T1.9 media-type pin: mutating requests must be application/json.
	const wrongType = await request('POST', '/v2/rooms', {
		headers: { 'content-type': 'text/plain', 'x-redline-node-key': nodeKey },
		body: '{}',
	});
	check('wrong content-type -> 415', wrongType.status === 415, `got ${wrongType.status}`);
	const jsonLookalike = await request('POST', '/v2/rooms', {
		headers: { 'content-type': 'application/jsonp', 'x-redline-node-key': nodeKey },
		body: '{}',
	});
	check('JSON lookalike content-type -> 415', jsonLookalike.status === 415, `got ${jsonLookalike.status}`);

	const foreignOrigin = await request('POST', '/v2/rooms', {
		headers: { ...jsonHeaders(nodeKey), origin: 'https://evil.example' },
		body: '{}',
	});
	check('foreign Origin -> 403', foreignOrigin.status === 403, `got ${foreignOrigin.status}`);

	const malformedPath = await request('GET', '/%ZZ');
	check('malformed escaped path -> 400 without crashing', malformedPath.status === 400, `got ${malformedPath.status}`);
	check('roomhost survives malformed escaped path', await statusJson() !== null);

	// 3. T1.9 key pin: a mutating request without the node key is refused.
	const noKey = await request('POST', '/v2/rooms', {
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ map: '0'.repeat(40), slots: 2, name: 'x' }),
	});
	check('missing node key -> 403', noKey.status === 403, `got ${noKey.status}`);

	// 4. T1.10 create validation: the map must be a catalog uid.
	const badMap = await request('POST', '/v2/rooms', {
		headers: jsonHeaders(nodeKey),
		body: JSON.stringify({ map: 'f'.repeat(40), slots: 2, name: 'nodegate' }),
	});
	check('unknown map -> 400 invalid/map',
		badMap.status === 400 && badMap.json?.error === 'invalid' && badMap.json?.field === 'map',
		`got ${badMap.status} ${badMap.text.slice(0, 120)}`);

	// 4b. §5.3 health shape: schema/build/visibility/relay/rooms/players.
	const health = await request('GET', '/v2/health');
	check('GET /v2/health -> §5.3 body',
		health.status === 200
		&& health.json?.schema === 1
		&& typeof health.json?.build === 'string'
		&& ['lan', 'public', 'donate'].includes(health.json?.visibility)
		&& typeof health.json?.relay === 'object' && health.json.relay !== null
		&& health.json.relay.connected === false && health.json.relay.closeCode === null
		&& Number.isInteger(health.json?.rooms) && Number.isInteger(health.json?.players),
		`got ${health.status} ${health.text.slice(0, 200)}`);

	// 5. Create over /v2 (T2.2/T2.4): 201 {room} with state "booting" and the
	// authoritative wsUrl, answered immediately (no blocking boot wait).
	let room = null;
	const created = await request('POST', '/v2/rooms', {
		headers: jsonHeaders(nodeKey),
		body: JSON.stringify({ map: GATE.uid, slots: 2, name: 'nodegate', solo: false }),
	});
	const wrapped = created.json?.room ?? null;
	if (created.status === 201 && wrapped) {
		room = wrapped;
		check('POST /v2/rooms -> 201 {room, state booting, wsUrl}',
			typeof room?.roomId === 'string' && /^[0-9a-f]{16}$/.test(room.roomId)
			&& room?.state === 'booting'
			&& room?.wsUrl === `ws://127.0.0.1:${WS_PORT}/g/${room.roomId}`
			&& typeof room?.name === 'string' && Number.isInteger(room?.slots) && Number.isInteger(room?.players),
			`room: ${created.text.slice(0, 240)}`);
	} else {
		check('POST /v2/rooms -> 201 {room, state booting, wsUrl}', false, `got ${created.status} ${created.text.slice(0, 200)}`);
	}

	// 5b. §5.3 listing: GET /v2/rooms carries schema and ALL states.
	const listed = await request('GET', '/v2/rooms');
	check('GET /v2/rooms -> {schema, rooms[]} lists the booting room',
		listed.status === 200 && listed.json?.schema === 1
		&& Array.isArray(listed.json?.rooms)
		&& listed.json.rooms.some(r => r.roomId === room?.roomId && r.state === 'booting' && typeof r.wsUrl === 'string'),
		`got ${listed.status} ${listed.text.slice(0, 200)}`);
	// T3.5: the shell needs the node's LAN identity to run the listener's
	// --self filter.
	check('GET /v2/health carries nodeId',
		/^[0-9a-f]{12}$/.test(health.json?.nodeId ?? ''),
		`nodeId ${JSON.stringify(health.json?.nodeId)}`);

	if (room?.roomId) {
		const reserved = await poll(async () => {
			const listing = await request('GET', '/v2/rooms');
			return listing.json?.rooms?.find(r => r.roomId === room.roomId && r.state === 'reserved') ?? null;
		}, 20_000, 500);
		check('create -> reserved within 20 s (GET /v2/rooms)', reserved !== null,
			`room never reserved\n${(await statusJson())?.log?.slice(-15).join('\n') ?? logRing.slice(-15).join('\n')}`);

		// The raw port is node-internal since T2.8 — read it from the
		// loopback-only /status.json diagnostics, never from /v2.
		const internal = (await statusJson())?.rooms?.find(r => r.roomId === room.roomId);
		check('dedicated TCP accept from loopback', Number.isInteger(internal?.port) && await portAccepts(internal.port),
			`nothing accepting on 127.0.0.1:${internal?.port ?? '?'}`);
		// The raw game port bypasses the host key, Ranked claims and relay limits, so it
		// must only be reachable through the node's own WS mux (REDLINE_BIND=loopback).
		const lanAddress = externalIPv4();
		check('dedicated TCP refused from a non-loopback address',
			lanAddress === null || (Number.isInteger(internal?.port) && !(await portAccepts(internal.port, lanAddress))),
			`${lanAddress}:${internal?.port ?? '?'} accepted a connection`);

		// 7. DELETE kills the process tree, empties the directory, removes the
		// room dir, and leaves no orphan process or listener behind.
		const roomDir = path.join(dataDir, 'rooms', room.roomId);
		let dedicatedPid = null;
		try { dedicatedPid = Number(fs.readFileSync(path.join(roomDir, 'server.pid'), 'utf8').trim()); } catch { /* unreadable */ }
		// The raw port is node-internal since T2.8 — read it from the
		// loopback-only /status.json diagnostics, never from /v2.
		const dedicatedPort = (await statusJson())?.rooms?.find(r => r.roomId === room.roomId)?.port ?? null;

		const removed = await request('DELETE', `/v2/rooms/${room.roomId}`, { headers: jsonHeaders(nodeKey) });
		check('DELETE /v2/rooms/<id> -> 204', removed.status === 204, `got ${removed.status}`);

		const gone = await poll(async () =>
			((await statusJson())?.rooms?.length ?? 1) === 0 && !fs.existsSync(roomDir), 15_000, 300);
		check('room + room dir removed', gone !== null,
			`rooms=${JSON.stringify((await statusJson())?.rooms?.map(r => r.roomId) ?? [])} dirExists=${fs.existsSync(roomDir)}`);
		const pidDead = await poll(async () => !Number.isInteger(dedicatedPid)
			|| (!processAlive(dedicatedPid) && !Number.isInteger(dedicatedPort))
			|| (!processAlive(dedicatedPid) && !(await portAccepts(dedicatedPort))), 15_000, 300);
		check('no orphan dedicated process', pidDead !== null, `pid ${dedicatedPid} still alive/listening`);
	}
} finally {
	await teardown();
}
// ---- T3.19 standing mode (§9.2): a second node driven purely by its own
// rooms file — no client creates anything, the community caps are the ones
// the node enforces on itself. ----
async function standingPhase() {
	const entryA = 'Gate Standing A';
	const entryB = 'Gate Standing B';
	const idleKillFloor = PROTOCOL.timeouts.idleKillFloorSeconds;
	const srequest = (method, pathname, opts = {}) => new Promise((resolve, reject) => {
		// Same contract as request(): dial the loopback API, override only
		// the Host header (the node's misdirection pin wants the exact port).
		const req = http.request({
			host: '127.0.0.1', port: S_HTTP, path: pathname, method,
			headers: { ...(opts.headers ?? {}), host: S_API },
		}, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString();
				let json = null;
				try { json = JSON.parse(text); } catch { /* not json */ }
				resolve({ status: res.statusCode, json, text });
			});
		});
		req.on('error', reject);
		req.setTimeout(gateMs(10_000), () => req.destroy(new Error('request timeout')));
		if (opts.body !== null && opts.body !== undefined)
			req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
		req.end();
	});

	const dataDirS = fs.mkdtempSync(path.join(os.tmpdir(), 'nodegate-standing-'));
	// This phase intentionally waits through three idle-kill windows before it
	// exercises restart behavior.  Hosted CI load can change dramatically in
	// those 90 seconds and make the product's real capacity guard reject the
	// replacement, turning a lifecycle test into a runner-load lottery.  The
	// capacity thresholds have their own deterministic tests; pin this gate's
	// machine sample so it measures only standing-room lifecycle behavior.
	const capacityShim = path.join(dataDirS, 'capacity-shim.mjs');
	fs.writeFileSync(capacityShim, [
		"import os from 'node:os';",
		'os.loadavg = () => [0, 0, 0];',
		'os.freemem = () => 8 * 1024 * 1024 * 1024;',
		'process.availableMemory = () => 8 * 1024 * 1024 * 1024;',
	].join('\n'));
	const roomsFile = path.join(dataDirS, 'rooms.json');
	fs.writeFileSync(roomsFile, JSON.stringify({
		schema: 1,
		rooms: [
			{ name: entryA, slots: 2, maps: [GATE.uid], settings: { gamespeed: 'default', tod: 'auto', weather: 'on' } },
			{ name: entryB, slots: 2, maps: [GATE.uid] },
		],
	}));
	const logRingS = [];
	const nodeKeyS = crypto.randomBytes(32).toString('hex');
	const spawnStandingNode = extraArgs => {
		const child = spawn(process.execPath, [
			'--import', pathToFileURL(capacityShim).href,
			roomhostScript,
			'--ws', String(S_WS), '--http', String(S_HTTP),
			'--base-port', String(S_BASE), '--max-matches', '2',
			'--idle-kill', String(idleKillFloor),
			'--data-dir', dataDirS,
			...extraArgs,
		], {
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
			env: { ...process.env, REDLINE_NODE_KEY: nodeKeyS },
		});
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding('utf8');
			stream.on('data', chunk => {
				for (const line of chunk.split('\n')) {
					if (!line.trim()) continue;
					logRingS.push(line);
					if (logRingS.length > 600) logRingS.shift();
				}
			});
		}
		return child;
	};
	const stopStandingNode = async child => {
		if (child.exitCode === null && child.signalCode === null) {
			try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
		}
		await poll(() => child.exitCode !== null || child.signalCode !== null, 8000, 200);
		if (child.exitCode === null && child.signalCode === null) {
			try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
		}
	};
	const sStatus = async () => {
		try {
			const res = await srequest('GET', '/status.json');
			return res.status === 200 ? res.json : null;
		} catch { return null; }
	};
	const sRooms = async () => {
		try {
			const res = await srequest('GET', '/v2/rooms');
			return res.status === 200 ? (res.json?.rooms ?? []) : null;
		} catch { return null; }
	};
	const roomsByName = async () => {
		const rooms = await sRooms();
		return rooms === null ? null : new Map(rooms.map(room => [room.name, room]));
	};
	// The node-internal dedicated port + pid of a room (loopback diagnostics).
	const roomInternals = async roomId => {
		const status = await sStatus();
		const room = status?.rooms?.find(r => r.roomId === roomId) ?? null;
		if (!room) return { port: null, pid: null };
		let pid = null;
		try { pid = Number(fs.readFileSync(path.join(dataDirS, 'rooms', roomId, 'server.pid'), 'utf8').trim()); } catch { /* gone */ }
		return { port: room.port, pid };
	};

	let node = null;
	const knownPids = new Set();
	try {
		// Refusals first — they exit before any port is bound. --lan is
		// rejected in standing mode (a community server is relay-only), and a
		// rooms file with more entries than --max-matches refuses to start.
		const lanRefused = spawnStandingNode(['--mode', 'standing', '--lan', '--rooms-file', roomsFile]);
		const lanText = await new Promise(resolve => {
			let text = '';
			for (const stream of [lanRefused.stdout, lanRefused.stderr]) {
				stream.setEncoding('utf8');
				stream.on('data', c => { text += c; });
			}
			lanRefused.once('exit', code => resolve({ code, text }));
		});
		check('standing --lan refused', lanText.code !== null && lanText.code !== 0
			&& lanText.text.includes('--lan is not available in standing mode'),
			`exit ${lanText.code}`);
		const bigFile = path.join(dataDirS, 'too-many.json');
		fs.writeFileSync(bigFile, JSON.stringify({
			schema: 1,
			rooms: [1, 2, 3].map(i => ({ name: `X${i}`, slots: 2, maps: [GATE.uid] })),
		}));
		const capRefused = spawnStandingNode(['--mode', 'standing', '--rooms-file', bigFile]);
		const capText = await new Promise(resolve => {
			let text = '';
			for (const stream of [capRefused.stdout, capRefused.stderr]) {
				stream.setEncoding('utf8');
				stream.on('data', c => { text += c; });
			}
			capRefused.once('exit', code => resolve({ code, text }));
		});
		check('rooms file over --max-matches refused', capText.code !== null && capText.code !== 0
			&& capText.text.includes('--max-matches allows'),
			`exit ${capText.code}`);

		// The standing node boots.
		node = spawnStandingNode(['--mode', 'standing', '--rooms-file', roomsFile]);
		const up = await poll(sStatus, 20_000);
		check('standing node reachable', up !== null, `no /status.json within 20 s\n${logRingS.slice(-12).join('\n')}`);
		if (!up) return;

		// Both configured rooms reach `lobby` with NO client involved — a
		// standing room skips `reserved` on the first accept probe.
		const bothLobby = await poll(async () => {
			const map = await roomsByName();
			return map !== null
				&& map.get(entryA)?.state === 'lobby'
				&& map.get(entryB)?.state === 'lobby'
				&& map.size === 2 ? map : null;
		}, 30_000, 500);
		check('both standing rooms reach lobby with no client', bothLobby !== null,
			`rooms: ${JSON.stringify((await sRooms())?.map(r => ({ n: r.name, s: r.state })))}\n${logRingS.slice(-12).join('\n')}`);
		if (!bothLobby) return;
		const idA = bothLobby.get(entryA).roomId;
		const idB = bothLobby.get(entryB).roomId;

		// The create/delete API is closed in standing mode.
		const refusedPost = await srequest('POST', '/v2/rooms', {
			headers: jsonHeaders(nodeKeyS),
			body: { map: GATE.uid, slots: 2, name: 'nope' },
		});
		check('standing POST /v2/rooms -> 403 standing-mode',
			refusedPost.status === 403 && refusedPost.json?.error === 'standing-mode',
			`got ${refusedPost.status} ${refusedPost.text.slice(0, 80)}`);
		const refusedDelete = await srequest('DELETE', `/v2/rooms/${idA}`, { headers: jsonHeaders(nodeKeyS) });
		check('standing DELETE /v2/rooms/<id> -> 403 standing-mode',
			refusedDelete.status === 403 && refusedDelete.json?.error === 'standing-mode',
			`got ${refusedDelete.status} ${refusedDelete.text.slice(0, 80)}`);

		// A room idle for 3× the idle-kill window is still alive: the reaper
		// skips standing rooms in `lobby`, and no replacement id appeared.
		console.log(`.. waiting ${idleKillFloor * 3} s (3× idle-kill) to prove the reaper skips standing lobbies`);
		const idleDeadline = Date.now() + idleKillFloor * 3 * 1000;
		let stillAlive = true;
		while (Date.now() < idleDeadline) {
			const map = await roomsByName();
			if (map === null || map.get(entryA)?.roomId !== idA || map.get(entryB)?.roomId !== idB
				|| map.get(entryA)?.state !== 'lobby' || map.get(entryB)?.state !== 'lobby' || map.size !== 2) {
				stillAlive = false;
				break;
			}
			await new Promise(r => setTimeout(r, 2000));
		}
		check('standing lobby survives 3× idle-kill window', stillAlive,
			`rooms: ${JSON.stringify((await sRooms())?.map(r => ({ n: r.name, s: r.state })))}`);

		// Killing a room's server brings up a replacement with a new roomId
		// within 30 s.
		const internalsA = await roomInternals(idA);
		if (Number.isInteger(internalsA.pid)) knownPids.add(internalsA.pid);
		if (Number.isInteger(internalsA.pid)) process.kill(internalsA.pid, 'SIGKILL');
		let replacementA = null;
		const replaceDeadline = Date.now() + gateMs(30_000);
		while (Date.now() <= replaceDeadline) {
			const map = await roomsByName();
			const room = map?.get(entryA);
			if (room && room.roomId !== idA && room.state === 'lobby') {
				replacementA = room;
				break;
			}
			await new Promise(r => setTimeout(r, 400));
		}
		check('killed room replaced with new roomId within 30 s', replacementA !== null,
			`rooms: ${JSON.stringify((await sRooms())?.map(r => ({ n: r.name, s: r.state })))}\n${logRingS.slice(-12).join('\n')}`);

		// Five consecutive fast deaths disable the entry. The entry's first
		// instance has been idle since boot — its death is a SLOW death by
		// definition and resets the consecutive counter, so kill it first
		// (round 0) and wait for the replacement; rounds 1…5 then each kill
		// a fresh instance well inside the fast-death window. After the 5th
		// fast death no replacement may ever appear, and the disable line is
		// logged with the dead instance's stderr tail.
		let disabled = true;
		for (let round = 0; round <= PROTOCOL.standing.fastDeathLimit; round++) {
			const map = await roomsByName();
			const room = map?.get(entryB);
			if (!room) { disabled = false; break; }
			const internals = await roomInternals(room.roomId);
			if (!Number.isInteger(internals.pid)) { disabled = false; break; }
			knownPids.add(internals.pid);
			process.kill(internals.pid, 'SIGKILL');
			// The dying room must leave the listing (exit event processed);
			// after the FINAL kill the entry is disabled and must never come
			// back, so "gone" is the expected end state there.
			const gone = await poll(async () => {
				const after = await roomsByName();
				if (after === null) return null;
				// Still listed (dying, or a replacement booting) — keep polling.
				if (after.has(entryB)) return null;
				return true;
			}, 10_000, 200);
			console.log(`.. round ${round}: killed ${room.roomId.slice(0, 8)} (pid ${internals.pid}) -> gone=${gone === true}`);
			if (gone !== true) { disabled = false; break; }
			// The node restarts the entry after restartAfterEndSeconds; wait
			// for the replacement — except after the final (5th fast) kill,
			// which must disable the entry for good.
			if (round < PROTOCOL.standing.fastDeathLimit) {
				const again = await poll(async () => {
					const next = (await roomsByName())?.get(entryB);
					return next && next.roomId !== room.roomId && next.state === 'lobby' ? next : null;
				}, 20_000, 400);
				if (!again) { disabled = false; break; }
			}
		}
		let noMoreB = false;
		if (disabled) {
			noMoreB = true;
			const quietDeadline = Date.now() + gateMs(15_000);
			while (Date.now() <= quietDeadline) {
				const map = await roomsByName();
				if (map !== null && map.has(entryB)) { noMoreB = false; break; }
				await new Promise(r => setTimeout(r, 500));
			}
		}
		check('five fast deaths disable the entry', disabled && noMoreB
			&& logRingS.some(line => line.includes(`standing room "${entryB}" disabled:`)),
			`disabled=${disabled} noMoreB=${noMoreB} log=${logRingS.filter(l => l.includes('disabled')).join(' // ').slice(0, 200)}\nstanding node log tail:\n${logRingS.slice(-30).join('\n')}`);

		// The disabled entry stays disabled and its pid was reaped (checked
		// again after teardown below).
	} finally {
		if (node) await stopStandingNode(node);
		fs.rmSync(dataDirS, { recursive: true, force: true });
	}
	// No orphan dedicated servers survive the standing node.
	const orphansDead = await poll(async () => {
		for (const pid of knownPids) {
			if (!Number.isInteger(pid)) continue;
			if (processAlive(pid) && cmdlineOpenRAServer(pid)) return false;
		}
		return true;
	}, 15_000, 300);
	check('standing teardown leaves no orphan dedicated', orphansDead !== null,
		`pids ${[...knownPids].join(',')} still alive`);
}


// T3.14 regression pin: node-cli must pass --http through to startNode.
// nodegate used to drive roomhost.mjs directly, so a dropped httpPort in
// buildOptions — the API silently binding 8331 instead of the requested
// port — shipped: every desktop host-start timed out on /v2/health.
{
	const CLI_HTTP = Number(process.env.NODEGATE_CLI_HTTP ?? '13636');
	const CLI_WS = Number(process.env.NODEGATE_CLI_WS ?? '13637');
	const dataDirCli = fs.mkdtempSync(path.join(os.tmpdir(), 'nodegate-cli-'));
	const cli = spawn(process.execPath, [
		path.join(toolsDir, 'node-cli.mjs'),
		'--mode', 'own', '--lan',
		'--ws', String(CLI_WS), '--http', String(CLI_HTTP),
		'--max-matches', '1',
		'--idle-kill', '60',
		'--data-dir', dataDirCli,
	], {
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
		env: { ...process.env, REDLINE_NODE_KEY: crypto.randomBytes(32).toString('hex') },
	});
	try {
		const cliHealth = async () => {
			try {
				const res = await fetch(`http://127.0.0.1:${CLI_HTTP}/v2/health`, { signal: AbortSignal.timeout(gateMs(2500)) });
				return res.status === 200 ? await res.json() : null;
			} catch { return null; }
		};
		const health = await poll(cliHealth, 20_000);
		check('node-cli --http honored: /v2/health on the given port', health !== null,
			`no answer on 127.0.0.1:${CLI_HTTP}`);
	} finally {
		if (cli.exitCode === null && cli.signalCode === null) {
			try { process.kill(-cli.pid, 'SIGTERM'); } catch { try { cli.kill('SIGTERM'); } catch { /* gone */ } }
		}
		await poll(() => cli.exitCode !== null || cli.signalCode !== null, 8000, 200);
		if (cli.exitCode === null && cli.signalCode === null) {
			try { process.kill(-cli.pid, 'SIGKILL'); } catch { try { cli.kill('SIGKILL'); } catch { /* gone */ } }
		}
		fs.rmSync(dataDirCli, { recursive: true, force: true });
	}
}


await standingPhase();

if (fatal) {
	console.log(`FAIL nodegate crashed: ${fatal?.stack ?? fatal}`);
	results.push({ name: 'nodegate crashed', ok: false });
}

const failures = results.filter(r => !r.ok).length;
console.log(`=== nodegate: ${results.length - failures}/${results.length} checks passed ===`);
process.exitCode = failures > 0 ? failures : 0;
