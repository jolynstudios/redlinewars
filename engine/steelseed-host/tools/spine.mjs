// SteelSeed spine — the central relay of the federated network.
//
// Nodes dial OUT to the spine and keep one control tunnel open (protocol 2,
// §5.5), so machines behind NAT can host matches. Players only ever see the
// spine:
//   GET  /v2/config                 -> network configuration for clients
//   GET  /v2/rooms                  -> Room objects with the authoritative wsUrl
//   POST /v2/rooms                  -> placement (off unless relay.json opts in)
//   GET  /rooms                     -> legacy endpoint-free array (read-only)
//   POST /rooms                     -> 410 {"error":"upgrade"}
//   WS   /g/<roomId>                -> player channel; bytes are tunneled to
//                                      the owning node over its control ws
//
// Wire protocol on a node tunnel (§5.5):
//   JSON text  node->spine: {t:'register',proto:2,nodeKey,build,mode,name,
//                            maxMatches,app}     first message, within 5 s
//                           {t:'rooms',rooms:[…]}  every 10 s and on change
//                           {t:'status',…}         every 5 s
//   JSON text  spine->node: {t:'registered',nodeId,tier,caps}
//                           {t:'create',…}         placement only (Phase 6)
//                           {t:'open',…} {t:'close',chanId}
//   binary     spine<->node: [u16 BE chanId][payload]   (player data channel)
//
// Open registration (T2.5): identity is the per-install nodeKey — a stable
// handle, never authentication of a person — so every hard limit stays
// IP-keyed. The owner token (--owner-token-file) only selects the owner
// tier; without it the relay still starts and serves community tier.
// Protocol 1 (a register without a `proto` field) is accepted only with a
// valid owner token. Close codes: 4001 bad owner token · 4002 replaced ·
// 4003 build not accepted · 4004 too many nodes per IP · 4005 draining ·
// 4006 no register within 5 s · 4008 rate or caps exceeded.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createWsWriter } from './relay-flow.mjs';
import { consumeCreateBudget, orderedPlacementCandidates } from './placement-policy.mjs';
import {
	hostKeyHash,
	randomHostKey,
	validParticipantClaim,
	validRankedRoomClaim,
	verifyClaim,
} from './ranked-claims.mjs';

const args = process.argv.slice(2);
function arg(name, fallback) {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dirPort = Number(arg('--http', '13600'));
const relayWsPort = Number(arg('--ws', '13601'));
// L11/L12/§5.5 constants (ports, limits, close codes, liveness timings):
// protocol.json is the single source; no restated magic numbers here.
const protocol = JSON.parse(fs.readFileSync(path.join(scriptDir, 'protocol.json'), 'utf8'));
const limits = protocol.limits;

// ---- relay.json (§10.1): the config file holds everything that can change
// at runtime. --config <file> is read at start (invalid file -> refuse to
// start) and re-read on SIGHUP (invalid file -> keep the old config, log).
const CONFIG_DEFAULTS = {
	publicUrl: '',        // empty -> this relay on loopback (gate default)
	siteOrigins: [],
	browserMultiplayer: 'off',
	debugMultiplayer: false,
	placement: 'off',
	ownerOverflow: false, // ordinary rooms may use the owner node (Ranked always may)
	acceptedBuilds: [],   // empty -> every build accepted (no gate ships a config)
	app: { latest: '', downloadUrl: '' },
};
const BROWSER_SWITCH_STATES = ['off', 'join', 'full'];
const PLACEMENT_MODES = ['off', 'donated', 'donated+owner'];
function parseConfig(text) {
	const raw = JSON.parse(text);
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('config must be a JSON object');
	const cfg = { ...CONFIG_DEFAULTS };
	if (raw.publicUrl !== undefined) {
		if (typeof raw.publicUrl !== 'string' || !/^https?:\/\//.test(raw.publicUrl)) throw new Error('publicUrl must be an http(s) URL');
		cfg.publicUrl = raw.publicUrl.replace(/\/+$/, '');
	}
	if (raw.siteOrigins !== undefined) {
		if (!Array.isArray(raw.siteOrigins) || raw.siteOrigins.some(o => typeof o !== 'string')) throw new Error('siteOrigins must be an array of origin strings');
		cfg.siteOrigins = raw.siteOrigins.map(o => o.replace(/\/+$/, ''));
	}
	if (raw.browserMultiplayer !== undefined) {
		if (!BROWSER_SWITCH_STATES.includes(raw.browserMultiplayer)) throw new Error(`browserMultiplayer must be one of ${BROWSER_SWITCH_STATES.join('|')}`);
		cfg.browserMultiplayer = raw.browserMultiplayer;
	}
	if (raw.debugMultiplayer !== undefined) {
		if (typeof raw.debugMultiplayer !== 'boolean') throw new Error('debugMultiplayer must be a boolean');
		cfg.debugMultiplayer = raw.debugMultiplayer;
	}
	if (raw.placement !== undefined) {
		if (!PLACEMENT_MODES.includes(raw.placement)) throw new Error(`placement must be one of ${PLACEMENT_MODES.join('|')}`);
		cfg.placement = raw.placement;
	}
	if (raw.ownerOverflow !== undefined) {
		if (typeof raw.ownerOverflow !== 'boolean') throw new Error('ownerOverflow must be a boolean');
		cfg.ownerOverflow = raw.ownerOverflow;
	}
	if (raw.acceptedBuilds !== undefined) {
		if (!Array.isArray(raw.acceptedBuilds) || raw.acceptedBuilds.some(b => typeof b !== 'string')) throw new Error('acceptedBuilds must be an array of build ids');
		cfg.acceptedBuilds = [...raw.acceptedBuilds];
	}
	if (raw.app !== undefined) {
		if (typeof raw.app !== 'object' || raw.app === null || Array.isArray(raw.app)) throw new Error('app must be an object');
		if (raw.app.latest !== undefined && typeof raw.app.latest !== 'string') throw new Error('app.latest must be a string');
		if (raw.app.downloadUrl !== undefined && typeof raw.app.downloadUrl !== 'string') throw new Error('app.downloadUrl must be a string');
		cfg.app = { latest: raw.app.latest ?? '', downloadUrl: raw.app.downloadUrl ?? '' };
	}
	return cfg;
}
let config = CONFIG_DEFAULTS;
const configFile = arg('--config', null);
if (configFile) {
	try { config = parseConfig(fs.readFileSync(configFile, 'utf8')); }
	catch (e) {
		console.error(`[spine] refusing to start: invalid config ${configFile}: ${e.message}`);
		process.exit(1);
	}
}
process.on('SIGHUP', () => {
	if (!configFile) return;
	try {
		config = parseConfig(fs.readFileSync(configFile, 'utf8'));
		console.log(`[spine] reloaded config ${configFile} (placement=${config.placement} browserMultiplayer=${config.browserMultiplayer} acceptedBuilds=${config.acceptedBuilds.length})`);
	} catch (e) {
		console.error(`[spine] config reload kept the previous configuration: ${e.message}`);
		return;
	}
	// §10.5: a build dropped from acceptedBuilds stops hosting at once — its
	// tunnels close with 4003, exactly as a refused register would.
	if (config.acceptedBuilds.length === 0) return;
	for (const node of nodes.values()) {
		if (!node.registered || config.acceptedBuilds.includes(node.build)) continue;
		console.error(`[spine] node ${node.id} closed: build ${node.build} no longer accepted`);
		closeRelayWs(node.ws, 4003, config.acceptedBuilds.join(','));
	}
});

// wsUrl is always derived from the relay's own public URL (T2.3): the relay
// is authoritative for the player endpoint, so a node-local port can never
// leak into the directory and route players around the spine.
function publicUrl() {
	return config.publicUrl !== '' ? config.publicUrl : `http://127.0.0.1:${relayWsPort}`;
}
function wsUrlFor(roomId) {
	return `${publicUrl().replace(/^http/, 'ws')}/g/${roomId}`;
}

// Owner tier only (T2.5): the old shared node token is gone and never gates
// startup. A token here enables the owner tier — nothing else. Sources:
// --owner-token-file <file> (production, §10.1) or STEELSEED_NODE_TOKEN
// (the browser gates hand it through the environment so no secret lands in ps).
const trustProxy = args.includes('--trust-proxy');
function resolveOwnerToken() {
	const file = arg('--owner-token-file', null);
	if (file) {
		try {
			const token = fs.readFileSync(file, 'utf8').trim();
			if (token !== '') return token;
			console.error('[spine] --owner-token-file is empty: starting without an owner tier');
		} catch (e) {
			console.error(`[spine] refusing to start: --owner-token-file unreadable: ${e.message}`);
			process.exit(1);
		}
	}
	const env = process.env.STEELSEED_NODE_TOKEN;
	return typeof env === 'string' && env.trim() !== '' ? env.trim() : null;
}
const ownerToken = resolveOwnerToken();
function ownerTokenAuthorized(header) {
	if (ownerToken === null || typeof header !== 'string') return false;
	const expected = `Bearer ${ownerToken}`;
	return crypto.timingSafeEqual(
		crypto.createHash('sha256').update(header).digest(),
		crypto.createHash('sha256').update(expected).digest(),
	);
}
// Ranked claims are disabled unless the relay is provisioned with the
// account-service HMAC key. Ordinary placement never depends on this secret.
const rankedClaimSecret = process.env.REDLINE_RANKED_CLAIM_SECRET ?? null;
// Account-service ranked provisioning is a separate service credential. It
// reserves an owner slot before the signed room claim exists, avoiding the
// impossible "sign a key generated after signing" ordering.
const rankedProvisionToken = process.env.REDLINE_RANKED_PROVISION_TOKEN ?? null;
const rankedRulesHash = process.env.REDLINE_RANKED_RULES_HASH ?? null;
// Ranked account reservations and signed admission claims share the service's
// 90-second issuance window (MULTIPLAYER-SERVICE L16). Keep this explicit in
// the relay so a claim cannot outlive the concrete owner slot it names.
const configuredRankedProvisionTtlMs = Number(process.env.REDLINE_RANKED_PROVISION_TTL_MS);
const rankedProvisionTtlMs = Number.isFinite(configuredRankedProvisionTtlMs) && configuredRankedProvisionTtlMs >= 100
	? Math.floor(configuredRankedProvisionTtlMs) : 90_000;

// ---- drain (§10.4): SIGTERM sets draining, refuses new nodes (4005) and
// new rooms, and exits when no player channel is left or the timeout hit.
const drainTimeoutMs = Number(arg('--drain-timeout', '1800')) * 1000;
let draining = false;
const createRateWindowMs = 10 * 60_000;
const createRateLimit = 3;
const createRate = new Map(); // ip -> {start, count}
// Real client IP behind a proxy (T1.20): only when --trust-proxy is set AND
// the TCP peer is loopback may x-forwarded-for be believed — from any other
// peer that header is attacker-controlled.
function isLoopbackIp(ip) {
	if (!ip) return false;
	if (ip === '::1') return true;
	const v4 = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip;
	return v4.startsWith('127.');
}
function clientIpOf(req) {
	const remote = req.socket.remoteAddress ?? '?';
	if (trustProxy && isLoopbackIp(remote)) {
		const xff = req.headers['x-forwarded-for'];
		if (typeof xff === 'string') {
			const rightmost = xff.split(',').map(s => s.trim()).filter(Boolean).pop();
			if (rightmost) return rightmost;
		}
	}
	return remote;
}
function rankedProvisionAuthorized(req) {
	if (rankedProvisionToken === null) return false;
	const provided = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
	const expected = `Bearer ${rankedProvisionToken}`;
	const a = crypto.createHash('sha256').update(provided).digest();
	const b = crypto.createHash('sha256').update(expected).digest();
	return crypto.timingSafeEqual(a, b);
}
// Budget identity (T1.20): IPv4 as is; IPv6 truncated to its /64 so one
// household's many addresses share one budget instead of getting many.
function ipKey(ip) {
	if (typeof ip !== 'string' || ip === '') return '?';
	const s = ip.split('%')[0].trim().toLowerCase();
	if (!s.includes(':')) return s; // IPv4 (or anything non-IPv6) as is
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
	if (mapped) return mapped[1];
	const halves = s.split('::');
	let groups;
	if (halves.length === 2) {
		const head = halves[0] ? halves[0].split(':') : [];
		const tail = halves[1] ? halves[1].split(':') : [];
		if (head.length + tail.length > 7) return s;
		groups = [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => '0'), ...tail];
	} else {
		groups = s.split(':');
	}
	if (groups.length !== 8) return s;
	return `${groups.slice(0, 4).join(':')}::/64`;
}
// Rate windows live ten minutes; sweep expired entries so the map cannot grow without
// bound under a rotating address pool.
setInterval(() => {
	const now = Date.now();
	for (const [key, window] of createRate)
		if (now - window.start >= createRateWindowMs) createRate.delete(key);
	for (const [key, reservation] of rankedReservations) {
		if (reservation.expiresAt <= now) {
			rankedReservations.delete(key);
			if (reservation.idempotencyKey) rankedProvisionIdempotency.delete(reservation.idempotencyKey);
		}
	}
}, 60_000).unref();
// --serve-bundle (gates only): the relay serves no game bundle in production.
const serveBundle = args.includes('--serve-bundle');
// Loopback origins are always trusted (§5.2): the gates and desktop pages
// run on 127.0.0.1/localhost. Site origins come from relay.json.
function isLoopbackOrigin(origin) {
	return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}
function applyCors(req, res) {
	const origin = req.headers.origin;
	if (typeof origin !== 'string' || origin === '') return;
	if (isLoopbackOrigin(origin) || config.siteOrigins.includes(origin)) {
		res.setHeader('access-control-allow-origin', origin);
		res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
		res.setHeader('access-control-allow-headers', 'content-type');
		res.setHeader('vary', 'origin');
	}
}
// Rooms listed in the public directories (§5.4): only lobby and playing.
function listedRooms() {
	return liveNodes().filter(n => n.registered).flatMap(n => [...n.rooms.values()])
		.filter(room => room.state === 'lobby' || room.state === 'playing');
}

function engineRootOf(dir) {
	// spine.mjs lives in engine/steelseed-host/tools → engine/
	return path.resolve(dir, '../..');
}

// Composed client bundle (web dist + _framework) served at /steelseed/.
const bundleDir = path.join(engineRootOf(scriptDir), 'bin-browser', 'AppBundle');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.bin': 'application/octet-stream',
	'.dat': 'application/octet-stream',
	'.map': 'application/json',
};

// ---- node registry ----
const nodes = new Map(); // nodeId -> {id, ws, geo, capacity, rulesHash, rooms:Map<roomId,room>}
const roomOwner = new Map(); // roomId -> nodeId; the first node to report a room owns it
const placedRooms = new Map(); // roomId -> {hostKey, hostKeyHash, ranked, participantClaims, consumedClaims:Set}
const placedIpRooms = new Map(); // creator ipKey -> roomId, one live placed room per source
const nodeCooldowns = new Map(); // `${nodeId}|${ipKey}` -> unix millis
const rankedReservations = new Map(); // hostKeyHash -> {nodeId, roomId, hostKey, mapUid, simBuild, rulesHash, expiresAt}
const rankedProvisionIdempotency = new Map(); // caller key -> hostKeyHash
function liveNodes() {
	return [...nodes.values()].filter(n => n.ws.readyState === WebSocket.OPEN);
}

// Public summary strings: NFC-normalised, control characters stripped, clamped.
function cleanText(value, max) {
	return String(value).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max);
}
function boundedInteger(value, min, max, fallback = min) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}
// The public summary is rebuilt from whitelisted fields only (T1.23); whatever
// else a node attached to its report — the raw dedicated port, host settings,
// extras — is never forwarded to the directory.
const ROOM_TEXT_FIELDS = [['name', 32], ['hostName', 24], ['mapUid', 64], ['mapTitle', 64], ['state', 16]];
function publicRoomFields(r) {
	const out = {};
	if (typeof r.roomId === 'string') out.roomId = r.roomId;
	for (const [field, max] of ROOM_TEXT_FIELDS)
		if (typeof r[field] === 'string') out[field] = cleanText(r[field], max);
	if (Number.isFinite(r.slots)) out.slots = boundedInteger(r.slots, 0, protocol.nodeApi.slotsMaxOwnerTier);
	if (Number.isFinite(r.players)) out.players = boundedInteger(r.players, 0, protocol.nodeApi.slotsMaxOwnerTier);
	if (Number.isFinite(r.createdAt)) out.createdAt = r.createdAt;
	if (typeof r.locked === 'boolean') out.locked = r.locked;
	return out;
}
// Legacy directory row (§5.2 GET /rooms): endpoint-free, geo always empty —
// it exists only so pre-/v2 app builds show a room count instead of
// "relay offline".
function legacyRoomRow(room) {
	const s = room.summary;
	return {
		roomId: s.roomId,
		name: s.name,
		map: s.mapUid ?? '',
		slots: s.slots,
		players: s.players,
		createdAt: s.createdAt,
		geo: '',
	};
}
const HOST_KIND_BY_MODE = { own: 'player', standing: 'community', donate: 'donated' };
// Public Room object (§5.2 GET /v2/rooms): every field is built relay-side
// from the node's raw report; the player endpoint is always this relay's own
// ws URL (T2.3). hostKind comes from the node's mode (owner tier wins).
function v2Room(room) {
	const node = nodes.get(room.nodeId);
	const s = room.summary;
	return {
		roomId: s.roomId,
		name: s.name,
		map: { uid: s.mapUid ?? '', title: s.mapTitle ?? '' },
		slots: s.slots,
		players: s.players,
		state: room.state,
		locked: s.locked === true,
		build: node?.build ?? '',
		hostKind: node?.tier === 'owner' ? 'owner' : HOST_KIND_BY_MODE[node?.mode] ?? 'player',
		hostName: s.hostName ?? '',
		createdAt: s.createdAt,
		wsUrl: wsUrlFor(s.roomId),
	};
}

// ---- all-time + per-geo counters (anonymous: geo is the only identity) ----
// gamesStarted counts every successful create this boot; persistedTotals is
// the all-time number loaded from network-stats.json at boot (0 when absent).
let gamesStarted = 0;
/** Node messages that threw: logged (sparingly) and ignored, never fatal. */
let nodeMessageErrors = 0;
const byGeo = new Map(); // geo -> { games, reconnects, latencySamples, latencySum }
let persistedTotals = { totalGames: 0, byGeo: {} };

function geoRecord(geo) {
	let r = byGeo.get(geo);
	if (!r) { r = { games: 0, reconnects: 0, latencySamples: 0, latencySum: 0 }; byGeo.set(geo, r); }
	return r;
}

function pickNode(geo) {
	const candidates = placementCandidates(geo);
	return candidates[0] ?? null;
}

function nodeStatus(node) {
	const status = node.status ?? {};
	const freeMatches = Number.isFinite(status.freeMatches)
		? Number(status.freeMatches)
		: Math.max(0, node.capacity - node.rooms.size);
	return {
		freeMatches,
		healthy: status.healthy !== false && status.degraded !== true,
		rtt: node.latencyMs ?? Number.POSITIVE_INFINITY,
	};
}

function inCooldown(node) {
	const key = `${node.id}|${node.ipKey}`;
	const until = nodeCooldowns.get(key) ?? 0;
	if (until <= Date.now()) {
		nodeCooldowns.delete(key);
		return false;
	}
	return true;
}

function placementCandidates(geo, ownerOnly = false) {
	const wantedGeo = geo ? String(geo).toLowerCase() : '';
	const eligible = liveNodes().filter(node => {
		const status = nodeStatus(node);
		if (!node.registered || inCooldown(node) || !status.healthy || status.freeMatches <= 0 || status.rtt >= 80)
			return false;
		if (wantedGeo && !node.geo.toLowerCase().startsWith(wantedGeo)) return false;
		if (ownerOnly) return node.tier === 'owner';
		return node.tier !== 'owner' && node.mode === 'donate';
	});
	return eligible.sort((a, b) => nodeStatus(a).rtt - nodeStatus(b).rtt);
}

// Ordinary rooms use donated nodes. The owner node carries Ranked (placement
// 'donated+owner') and takes ordinary rooms only when the operator opts in with
// ownerOverflow, so public hosting never silently spills onto the owner's VPS.
function ordinaryOwnerAllowed() {
	return config.placement === 'donated+owner' && config.ownerOverflow === true;
}

function placementPool(geo, allowOwner) {
	const donated = placementCandidates(geo, false);
	const owner = allowOwner ? placementCandidates(geo, true) : [];
	return orderedPlacementCandidates(donated, owner, allowOwner);
}

function sameRankedRoom(a, b) {
	return a?.matchId === b?.matchId && a?.roomId === b?.roomId && a?.nonce === b?.nonce &&
		a?.simBuild === b?.simBuild && a?.mapUid === b?.mapUid && a?.rulesHash === b?.rulesHash;
}

function verifyRankedAdmission(body, hostKey) {
	if (rankedClaimSecret === null) return { error: 'ranked-unavailable' };
	if (body.ranked !== true || typeof body.roomClaim !== 'string') return { error: 'ranked-claim-required' };
	const roomClaim = verifyClaim(body.roomClaim, rankedClaimSecret);
	if (!validRankedRoomClaim(roomClaim) || roomClaim.hostKeyHash !== hostKeyHash(hostKey)) return { error: 'invalid-room-claim' };
	if (!/^[0-9a-f]{16}$/.test(roomClaim.roomId)) return { error: 'invalid-room-claim' };
	if (!Array.isArray(body.participantClaims) || body.participantClaims.length < 2 || body.participantClaims.length > 8)
		return { error: 'participant-claims-required' };
	const claims = [];
	const seats = new Set();
	const users = new Set();
	const nonces = new Set();
	for (const token of body.participantClaims) {
		const claim = verifyClaim(token, rankedClaimSecret);
		const participantRoom = claim?.room ?? claim;
		if (!validParticipantClaim(claim) || !sameRankedRoom(participantRoom, roomClaim)) return { error: 'invalid-participant-claim' };
		if (seats.has(claim.seat) || users.has(claim.userId) || nonces.has(claim.participantNonce)) return { error: 'duplicate-participant-claim' };
		seats.add(claim.seat); users.add(claim.userId); nonces.add(claim.participantNonce);
		claims.push({ token, payload: claim });
	}
	return { roomClaim, claims };
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const tunnelWriters = new WeakMap();
const closingSockets = new WeakSet();
function closeRelayWs(ws, code, reason) {
	if (ws.readyState === WebSocket.CLOSED || closingSockets.has(ws)) return;
	closingSockets.add(ws);
	const timer = setTimeout(() => ws.terminate(), 1000);
	timer.unref();
	ws.once('close', () => clearTimeout(timer));
	try { ws.close(code, reason); } catch { ws.terminate(); }
}

function dropPlayer(chanId, notify = true, code = 1000, reason = '') {
	const player = players.get(chanId);
	if (!player) return;
	players.delete(chanId);
	player.writer.close();
	closeRelayWs(player.ws, code, reason);
	const node = player.node;
	if (node) {
		node.channelCount = Math.max(0, node.channelCount - 1);
		if (notify) sendJson(node.ws, { t: 'close', chanId });
	}
}

function sendJson(ws, obj) {
	if (ws.readyState === WebSocket.OPEN) tunnelWriters.get(ws)?.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
	// Owner tier selection (§5.5): the upgrade carries
	// `authorization: Bearer <owner token>` only for the owner tier. A token
	// that is present but wrong — or present while no owner tier exists — is
	// the 4001 close; an absent token is a community-tier candidate.
	const bearerOwner = req.headers.authorization !== undefined;
	if (bearerOwner && !ownerTokenAuthorized(req.headers.authorization)) {
		console.error('[spine] node rejected: bad owner token');
		closeRelayWs(ws, 4001, protocol.relayCloseCodes['4001'].reason);
		return;
	}
	// A tunnel that has not registered yet lives at most registerWindowMs and
	// has caps of its own, so a burst of anonymous upgrades cannot lock real
	// nodes out. The global node cap (L11) is applied at register, where a node
	// replacing its own tunnel can be told apart from a new one.
	const connIpKey = ipKey(clientIpOf(req));
	let pendingNodes = 0, pendingFromIp = 0;
	for (const other of nodes.values()) {
		if (other.registered) continue;
		pendingNodes++;
		if (other.ipKey === connIpKey) pendingFromIp++;
	}
	if (pendingNodes >= limits.maxPendingNodes) {
		console.error('[spine] node rejected: relay saturated (node cap)');
		closeRelayWs(ws, 1013, protocol.playerCloseCodes['1013'].reason);
		return;
	}
	if (pendingFromIp >= limits.maxPendingNodesPerIp) {
		console.error(`[spine] node rejected: too many unregistered tunnels from ${connIpKey}`);
		closeRelayWs(ws, 4004, protocol.relayCloseCodes['4004'].reason);
		return;
	}
	// Draining refuses new nodes (§10.4): 4005.
	if (draining) {
		console.error('[spine] node rejected: relay draining');
		closeRelayWs(ws, 4005, protocol.relayCloseCodes['4005'].reason);
		return;
	}

	// Until `register` lands the socket is anonymous with a throwaway id; the
	// register replaces it by the nodeKey-derived nodeId (§5.5). The tunnel's
	// ipKey is pinned at accept time — every hard limit is IP-keyed.
	const node = {
		id: crypto.randomBytes(4).toString('hex'),
		ws,
		ipKey: connIpKey,
		registered: false,
		tier: bearerOwner ? 'owner' : 'community',
		mode: 'own', build: '', rulesHash: '', name: '', app: '',
		geo: '', capacity: 0, rooms: new Map(), status: null,
		latencyMs: null, connectedAt: Date.now(), reconnects: 0, channelCount: 0,
	};
	nodes.set(node.id, node);
	const writer = createWsWriter(ws, {
		limitBytes: 16 * 1024 * 1024,
		onFailure: error => {
			if (error.code === 'ERR_RELAY_BACKPRESSURE') ws.terminate();
			else closeRelayWs(ws, 1011, 'relay closed');
		},
	});
	tunnelWriters.set(ws, writer);
	// First liveness beat right away (an RTT sample without waiting a full
	// interval), then the shared 15 s beat below takes over.
	beatWs(ws);
	ws.on('pong', () => {
		const latencyMs = wsPong(ws);
		if (latencyMs !== null) node.latencyMs = latencyMs;
	});
	// The node must register within 5 s of tunnel open (§5.5) — 4006 otherwise.
	const registerTimer = setTimeout(() => {
		console.error(`[spine] node ${node.id} dropped: no register within ${limits.registerWindowMs} ms`);
		closeRelayWs(ws, 4006, protocol.relayCloseCodes['4006'].reason);
	}, limits.registerWindowMs);
	registerTimer.unref();
	console.log(`[spine] node ${node.id} connected (${liveNodes().length} live)`);

	// Registration is open to anyone, so nothing a node sends may crash the relay: a message that
	// is not a JSON object is dropped, and anything that still throws is logged and ignored
	// (a throw in a ws listener would otherwise take down every tunnel and match).
	ws.on('message', (data, isBinary) => {
		try {
			onNodeMessage(data, isBinary);
		} catch (err) {
			nodeMessageErrors++;
			if (nodeMessageErrors <= 20 || nodeMessageErrors % 1000 === 0)
				console.error(`[spine] node ${node.id} message ignored (${nodeMessageErrors} so far): ${String(err?.message ?? err).slice(0, 120)}`);
		}
	});
	const onNodeMessage = (data, isBinary) => {
		// A tunnel replaced by a newer one from the same node (4002) shares its
		// nodeId; nothing it still sends may touch the successor's rooms,
		// creates or channels.
		if (node.registered && nodes.get(node.id) !== node) return;
		if (!isBinary) {
			let msg;
			try { msg = JSON.parse(String(data)); } catch { return; }
			if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
			if (msg.t === 'register') {
				clearTimeout(registerTimer);
				if (node.registered) return; // one register per tunnel
				if (msg.proto === 2) {
					// Protocol 2 (§5.5): open registration. The nodeKey is a
					// stable handle (32 random bytes, base64url) — never proof
					// of a person, so the hard limits below stay IP-keyed.
					if (typeof msg.nodeKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(msg.nodeKey)) {
						console.error('[spine] node rejected: malformed nodeKey');
						closeRelayWs(ws, 4001, protocol.relayCloseCodes['4001'].reason);
						return;
					}
					// Build allowlist (§5.5): 4003, reason = the accepted builds.
					if (config.acceptedBuilds.length > 0 && !config.acceptedBuilds.includes(msg.build)) {
						console.error(`[spine] node rejected: build ${msg.build} not in acceptedBuilds`);
						closeRelayWs(ws, 4003, config.acceptedBuilds.join(','));
						return;
					}
					const nodeId = crypto.createHash('sha256').update(msg.nodeKey).digest('hex').slice(0, 12);
					// IP-keyed cap (L11): at most 2 node tunnels per ipKey. The tunnel
					// this register replaces (same identity) does not count, so a node
					// reconnecting at the cap can take its own place back.
					let fromSameIp = 0;
					for (const other of nodes.values())
						if (other !== node && other.registered && other.ipKey === node.ipKey && other.id !== nodeId) fromSameIp++;
					if (fromSameIp >= limits.maxNodesPerIp) {
						console.error(`[spine] node rejected: too many nodes from ${node.ipKey}`);
						closeRelayWs(ws, 4004, protocol.relayCloseCodes['4004'].reason);
						return;
					}
					// Global node cap (L11): a saturated relay refuses a new node with
					// 1013, but never a node taking its own identity back.
					let registeredNodes = 0;
					for (const other of nodes.values())
						if (other !== node && other.registered && other.id !== nodeId) registeredNodes++;
					if (registeredNodes >= limits.maxNodes) {
						console.error('[spine] node rejected: relay saturated (node cap)');
						closeRelayWs(ws, 1013, protocol.playerCloseCodes['1013'].reason);
						return;
					}
					// Same identity, newer connection: the OLDER tunnel gets 4002
					// and its close handler cleans up after itself; this tunnel
					// takes the identity over at once.
					const older = [...nodes.values()].find(n => n !== node && n.registered && n.id === nodeId);
					if (older) {
						console.log(`[spine] node ${nodeId} replaced by a newer connection`);
						closeRelayWs(older.ws, 4002, protocol.relayCloseCodes['4002'].reason);
					}
					nodes.delete(node.id);
					node.id = nodeId;
					node.registered = true;
					node.mode = protocol.nodeModes.includes(msg.mode) ? msg.mode : 'own';
					node.build = typeof msg.build === 'string' ? cleanText(msg.build, 16) : '';
					node.rulesHash = typeof msg.rulesHash === 'string' ? cleanText(msg.rulesHash, 128) : cleanText(msg.health?.rulesHash ?? '', 128);
					node.name = typeof msg.name === 'string' ? cleanText(msg.name, 32) : '';
						node.app = typeof msg.app === 'string' ? cleanText(msg.app, 16) : '';
						node.capacity = boundedInteger(msg.maxMatches, 0, limits.maxRoomsPerNode, 1);
						node.status = {
							freeMatches: boundedInteger(msg.slots?.freeMatches, 0, node.capacity, node.capacity),
							healthy: msg.health?.healthy !== false,
							degraded: msg.health?.degraded === true,
							players: boundedInteger(msg.health?.players, 0, limits.maxChannelsPerNode, 0),
							maxPlayersPerMatch: boundedInteger(msg.health?.maxPlayersPerMatch, 2, protocol.nodeApi.slotsMaxOwnerTier, msg.health?.degraded === true ? 2 : protocol.nodeApi.slotsMaxOwnerTier),
							dedicatedRssBytes: boundedInteger(msg.health?.dedicatedRssBytes, 0, Number.MAX_SAFE_INTEGER, 0),
						};
						nodes.set(nodeId, node);
					sendJson(ws, {
						t: 'registered',
						nodeId,
						tier: node.tier,
						caps: {
							channels: limits.maxChannelsPerNode,
							rateBps: limits.channelRateBps,
							burst: limits.channelBurstBytes,
						},
					});
					console.log(`[spine] node ${nodeId} registered tier=${node.tier} mode=${node.mode} build=${node.build || '?'} maxMatches=${node.capacity}`);
				} else if (bearerOwner) {
					// Protocol 1 (no `proto` field): valid owner token required. It
					// has no stable identity to replace, so the global cap is absolute.
					let registeredNodes = 0;
					for (const other of nodes.values())
						if (other !== node && other.registered) registeredNodes++;
					if (registeredNodes >= limits.maxNodes) {
						console.error('[spine] node rejected: relay saturated (node cap)');
						closeRelayWs(ws, 1013, protocol.playerCloseCodes['1013'].reason);
						return;
					}
					node.registered = true;
					node.geo = String(msg.geo ?? '');
					node.rulesHash = typeof msg.rulesHash === 'string' ? cleanText(msg.rulesHash, 128) : cleanText(msg.health?.rulesHash ?? '', 128);
					node.capacity = boundedInteger(msg.capacity, 0, limits.maxRoomsPerNode, 2);
					// Measured slot/health advertisement from the node's capacity sampler.
					node.status = {
						freeMatches: boundedInteger(msg.slots?.freeMatches, 0, node.capacity, node.capacity),
						healthy: msg.health?.healthy !== false,
						degraded: msg.health?.degraded === true,
						players: 0,
						maxPlayersPerMatch: msg.health?.degraded === true ? 2 : 8,
						dedicatedRssBytes: 0,
					};
					console.log(`[spine] node ${node.id} registered (protocol 1, owner) geo=${node.geo} capacity=${node.capacity}`);
				} else {
					console.error('[spine] node rejected: protocol 1 requires the owner token');
					closeRelayWs(ws, 4001, protocol.relayCloseCodes['4001'].reason);
				}
			} else if (!node.registered) {
				// rooms/status/create answers before register: not ours to trust.
			} else if (msg.t === 'rooms') {
				// Authoritative room list from the node (rooms it created AND
				// rooms the spine asked it to create). At most 4 rooms per
				// report (T1.23); the first node to report a roomId owns it and
				// a later claim by another node is dropped.
				const previous = [...node.rooms.keys()];
				node.rooms.clear();
				let accepted = 0;
				for (const r of Array.isArray(msg.rooms) ? msg.rooms : []) {
					if (accepted >= limits.maxRoomsPerNode) break; // at most 4 rooms per report
					if (typeof r?.roomId !== 'string' || !/^[0-9a-f]{16}$/.test(r.roomId)) continue;
					if (node.rooms.has(r.roomId)) continue;
					const owner = roomOwner.get(r.roomId);
					if (owner !== undefined && owner !== node.id) {
						// First reporter wins (T1.23): a later claim by another node
						// changes nothing.
						console.log(`[spine] room ${r.roomId} claim by node ${node.id} ignored (owned by ${owner})`);
						continue;
					}
					accepted++;
					roomOwner.set(r.roomId, node.id);
					// state rides with the report so the public directory can stay
					// lobby/playing (§5.4) while the routing registry keeps every
					// dialable room. Missing state = a legacy producer: visible.
					const state = typeof r.state === 'string' && r.state !== '' ? r.state : 'lobby';
					node.rooms.set(r.roomId, { nodeId: node.id, summary: publicRoomFields(r), state });
				}
				// A room the node no longer reports was dropped by that node.
					for (const roomId of previous)
						if (!node.rooms.has(roomId) && roomOwner.get(roomId) === node.id) {
							roomOwner.delete(roomId);
							const access = placedRooms.get(roomId);
							if (access) {
								placedRooms.delete(roomId);
								if (placedIpRooms.get(access.ipKey) === roomId) placedIpRooms.delete(access.ipKey);
							}
						}
			} else if (msg.t === 'create-ok') {
				const pending = pendingCreates.get(msg.reqId);
				if (pending?.node === node) {
					if (typeof msg.roomId !== 'string' || !/^[0-9a-f]{16}$/.test(msg.roomId)) {
						pending.reject(new Error('node returned an invalid room id'));
					} else if (roomOwner.has(msg.roomId) && roomOwner.get(msg.roomId) !== node.id) {
						pending.reject(new Error('room id already owned by another node'));
					} else {
						gamesStarted++;
						geoRecord(node.geo).games++;
						roomOwner.set(msg.roomId, node.id);
							const summary = publicRoomFields({
								roomId: msg.roomId,
								mapUid: msg.summary?.mapUid ?? msg.summary?.map ?? '',
								...msg.summary,
							});
							pending.resolve({
								roomId: msg.roomId,
								summary,
								hostKey: pending.hostKey,
								ranked: pending.ranked,
								participantClaims: pending.participantClaims,
							});
					}
					pendingCreates.delete(msg.reqId);
				}
			} else if (msg.t === 'create-fail') {
				const pending = pendingCreates.get(msg.reqId);
				if (pending?.node === node) {
					pending.reject(new Error(msg.error ?? 'node could not create room'));
					pendingCreates.delete(msg.reqId);
				}
			} else if (msg.t === 'status') {
				// Periodic live measurement from the node's capacity sampler.
				node.status = {
					freeMatches: boundedInteger(msg.freeMatches, 0, node.capacity, node.capacity),
					healthy: msg.healthy !== false,
					degraded: msg.degraded === true,
					players: boundedInteger(msg.players, 0, limits.maxChannelsPerNode, 0),
					maxPlayersPerMatch: boundedInteger(msg.maxPlayersPerMatch, 2, protocol.nodeApi.slotsMaxOwnerTier, msg.degraded === true ? 2 : protocol.nodeApi.slotsMaxOwnerTier),
					dedicatedRssBytes: boundedInteger(msg.dedicatedRssBytes, 0, Number.MAX_SAFE_INTEGER, 0),
				};
			} else if (msg.t === 'close') {
				if (players.get(msg.chanId)?.node === node)
					dropPlayer(msg.chanId, false);
			}
			return;
		}
		// Binary: player channel data [u16 BE chanId][payload]
		if (data.length < 2) return;
		const chanId = data.readUInt16BE(0);
		const player = players.get(chanId);
		if (player?.node !== node) return;
		// node -> player half of the per-channel token bucket (L11): a channel
		// over its bucket closes alone, the node's other channels keep flowing.
		if (!spendChannelBytes(player, 'out', data.length - 2)) {
			dropPlayer(chanId, true, 4008, protocol.relayCloseCodes['4008'].reason);
			return;
		}
		player.writer.send(data.subarray(2), { binary: true });
	};
	ws.on('close', () => {
		writer.close();
		tunnelWriters.delete(ws);
		clearTimeout(registerTimer);
		// Fold this connection into the anonymous per-geo totals; a later
		// re-register from the same machine counts as a reconnect there.
		const geo = geoRecord(node.geo);
		geo.reconnects++;
		if (node.latencyMs !== null) { geo.latencySamples++; geo.latencySum += node.latencyMs; }
		// A tunnel replaced by a newer connection from the same node (4002) shares
		// its nodeId with that successor, which has re-reported the rooms and now
		// owns the id-keyed state; the replaced tunnel only tears down its own
		// channels and in-flight creates.
		const replaced = nodes.get(node.id) !== node;
		if (!replaced) {
			nodes.delete(node.id);
			for (const [roomId, owner] of roomOwner)
				if (owner === node.id) roomOwner.delete(roomId);
			for (const room of node.rooms.values()) {
				if (room.state === 'playing')
					nodeCooldowns.set(`${node.id}|${node.ipKey}`, Date.now() + 30 * 60 * 1000);
				const roomId = room.summary?.roomId ?? room.roomId;
				const access = placedRooms.get(roomId);
				placedRooms.delete(roomId);
				if (access && placedIpRooms.get(access.ipKey) === roomId) placedIpRooms.delete(access.ipKey);
			}
		}
		// A create still in flight on this tunnel can never answer now: reject it
		// so the waiting POST /rooms fails at once (T1.24) instead of at its timer.
		for (const [reqId, pending] of pendingCreates) {
			if (pending.node !== node) continue;
			pendingCreates.delete(reqId);
			pending.reject(new Error('node went away'));
		}
		for (const [chanId, player] of players)
			if (player.node === node) dropPlayer(chanId, false, 1011, 'node went away');
		console.log(`[spine] node ${node.id} disconnected (${liveNodes().length} live)`);
	});
	ws.on('error', () => { /* close follows */ });
});

// ---- ws liveness (T1.21): protocol-level ping every 15 s on node tunnels and
// player sockets; RTT is measured relay-side from each ping->pong pair. A beat
// that finds the previous ping still unanswered counts a miss — after two such
// consecutive beats (two missed pongs) the socket is terminate()d, which drops
// a SIGSTOP-frozen tunnel within three beats (45 s). The JSON ping/pong of
// protocol 1 is gone — the ws library answers pongs itself.
const wsLiveness = new WeakMap(); // ws -> { missed, sentAt }
// --ping-interval-ms only exists so tests can run the beat fast.
const requestedPingMs = Number(arg('--ping-interval-ms', String(protocol.tunnel.pingIntervalSeconds * 1000)));
const pingIntervalMs = Number.isFinite(requestedPingMs) && requestedPingMs >= 100 ? requestedPingMs : protocol.tunnel.pingIntervalSeconds * 1000;
function beatWs(ws) {
	if (ws.readyState !== WebSocket.OPEN) return;
	let state = wsLiveness.get(ws);
	if (!state) {
		state = { missed: 0, sentAt: null };
		wsLiveness.set(ws, state);
	}
	if (state.sentAt !== null) {
		// The last ping is still unanswered. A socket that connected just before
		// this beat still has its first ping in flight, so one miss is tolerated:
		// only protocol.tunnel.missedPongLimit (2) consecutive beats without a pong
		// drop the socket. No second ping while one is outstanding keeps RTT honest.
		if (++state.missed >= protocol.tunnel.missedPongLimit) ws.terminate();
		return;
	}
	state.sentAt = Date.now();
	ws.ping();
}
function wsPong(ws) {
	const state = wsLiveness.get(ws);
	if (!state) return null;
	const latencyMs = state.sentAt !== null ? Math.max(0, Date.now() - state.sentAt) : null;
	state.missed = 0;
	state.sentAt = null;
	return latencyMs;
}
setInterval(() => {
	for (const node of liveNodes()) beatWs(node.ws);
	for (const player of players.values()) beatWs(player.ws);
}, pingIntervalMs).unref();

// ---- optional all-time totals file (no database) ----
// --data-dir (T1.25): writable state directory (a systemd StateDirectory=
// mount satisfies ProtectSystem=strict); default is the script's directory,
// as before.
const dataDir = path.resolve(arg('--data-dir', scriptDir));
const statsPath = path.join(dataDir, 'network-stats.json');
function loadStats() {
	try {
		const data = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
		if (data && Number.isFinite(data.totalGames)) persistedTotals = data;
	} catch { /* absent or unreadable: start at zero */ }
}
function saveStats() {
	const out = {
		totalGames: (persistedTotals?.totalGames ?? 0) + gamesStarted,
		byGeo: {},
		updatedAt: Date.now(),
	};
	for (const [geo, r] of byGeo) {
		const p = persistedTotals?.byGeo?.[geo] ?? {};
		out.byGeo[geo] = {
			games: (p.games ?? 0) + r.games,
			reconnects: (p.reconnects ?? 0) + r.reconnects,
		};
	}
	try { fs.writeFileSync(statsPath, JSON.stringify(out, null, '\t') + '\n'); }
	catch (e) { console.error(`[spine] network-stats.json write failed: ${e.message}`); }
}
loadStats();
setInterval(saveStats, 10 * 60_000).unref();
for (const sig of ['SIGINT']) process.on(sig, () => { saveStats(); process.exit(0); });
process.on('SIGTERM', () => {
	if (draining) return;
	draining = true;
	console.log(`[spine] SIGTERM: draining — new nodes and rooms refused, exiting when no channel is left or after ${drainTimeoutMs / 1000}s`);
	const finish = why => {
		console.log(`[spine] drain complete (${why})`);
		saveStats();
		process.exit(0);
	};
	const deadline = setTimeout(() => finish('drain timeout'), drainTimeoutMs);
	deadline.unref();
	const check = setInterval(() => {
		if (players.size === 0) {
			clearInterval(check);
			clearTimeout(deadline);
			finish('no channel left');
		}
	}, 250);
	check.unref();
});

// One pure snapshot of the whole network; /events frames are exactly this.
function networkSnapshot() {
	const live = liveNodes();
	const freeOf = n => n.status?.freeMatches ?? Math.max(0, n.capacity - n.rooms.size);
	return {
		ts: Date.now(),
		nodes: live.map(n => ({
			id: n.id.slice(0, 4),
			geo: n.geo,
			matches: n.capacity,
			freeMatches: freeOf(n),
			healthy: n.status?.healthy !== false,
			degraded: n.status?.degraded === true,
			maxPlayersPerMatch: n.status?.maxPlayersPerMatch ?? 8,
			rooms: n.rooms.size,
			players: n.status?.players ?? 0,
			latencyMs: n.latencyMs,
			reconnects: n.reconnects,
			connectedAt: n.connectedAt,
			dedicatedRssBytes: n.status?.dedicatedRssBytes ?? 0,
		})),
		totals: {
			nodes: live.length,
			matches: live.reduce((a, n) => a + n.rooms.size, 0),
			players: live.reduce((a, n) => a + (n.status?.players ?? 0), 0),
			freeSlots: live.reduce((a, n) => a + freeOf(n), 0),
			gamesStarted: gamesStarted + (persistedTotals?.totalGames ?? 0),
			uptimeMs: Math.round(process.uptime() * 1000),
		},
		byGeo: [...byGeo.entries()].map(([geo, r]) => ({
			geo,
			games: r.games + (persistedTotals?.byGeo?.[geo]?.games ?? 0),
			reconnects: r.reconnects + (persistedTotals?.byGeo?.[geo]?.reconnects ?? 0),
			latencyAvgMs: r.latencySamples ? Math.round(r.latencySum / r.latencySamples) : null,
		})),
	};
}

// Placement plumbing (§5.5 relay→node `create`): dormant until Phase 6
// (T6.1) wires POST /v2/rooms to it — pickNode deliberately stays unused.
const pendingCreates = new Map(); // reqId -> {nodeId, resolve, reject}
const players = new Map(); // chanId -> {ws, nodeId, roomId, ipKey, rate:{in,out}}
let nextChanId = 1;
// Per-channel, per-direction token bucket (L11): 64 KB/s refill, 512 KB burst.
// A channel over its bucket closes alone (4008); everything else keeps flowing.
function newChannelBucket() {
	return { tokens: limits.channelBurstBytes, last: Date.now() };
}
function spendChannelBytes(player, direction, bytes) {
	const bucket = player.rate[direction];
	const now = Date.now();
	bucket.tokens = Math.min(limits.channelBurstBytes, bucket.tokens + (now - bucket.last) / 1000 * limits.channelRateBps);
	bucket.last = now;
	if (bucket.tokens < bytes) return false;
	bucket.tokens -= bytes;
	return true;
}

// ---- public http: federated directory + room creation + player ws upgrade ----
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', c => {
			size += c.length;
			if (size > 16 * 1024) reject(new Error('body too large'));
			else chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		req.on('error', reject);
	});
}

function createRoomOnNode(node, body) {
	return new Promise((resolve, reject) => {
		const reqId = crypto.randomBytes(6).toString('hex');
		const hostKey = body.hostKey ?? randomHostKey();
		const timeoutSeconds = node.tier === 'owner'
			? protocol.timeouts.createTimeoutSeconds.owner
			: protocol.timeouts.createTimeoutSeconds.donated;
		const timeoutMs = timeoutSeconds * 1000;
		const timer = setTimeout(() => {
			if (pendingCreates.has(reqId)) {
				pendingCreates.delete(reqId);
				reject(new Error('node timed out creating room'));
			}
		}, timeoutMs);
		pendingCreates.set(reqId, {
			nodeId: node.id,
			node,
			hostKey,
			ranked: body.ranked === true,
			participantClaims: Array.isArray(body.participantClaims) ? body.participantClaims : [],
			resolve: v => { clearTimeout(timer); resolve(v); },
			reject: e => { clearTimeout(timer); reject(e); },
		});
		sendJson(node.ws, {
			t: 'create', reqId, roomId: body.roomId, map: body.map, slots: body.slots ?? null,
			settings: body.settings ?? {}, name: body.name ?? 'Room',
			password: body.password ?? '', hostKey, ranked: body.ranked === true,
			roomClaim: body.roomClaim ?? null, participantClaims: body.participantClaims ?? [],
		});
	});
}

// Live network dashboard: self-contained, no dependencies, no build step.
// Style follows the Twenty+One dark tokens: #08080D ink-black, #EDEDF2 ink,
// #F2A33C amber accent, mono uppercase kickers, hairline borders, CSS bars.
const NETWORK_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SteelSeed network</title>
<style>
:root{--bg:#08080D;--surface:#0C0C13;--ink:#EDEDF2;--soft:#8E8EA0;--accent:#F2A33C;--hair:rgba(237,237,242,.14);--ok:#6EE7A0;--bad:#FF6B5A}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.55 Archivo,system-ui,-apple-system,sans-serif;padding:40px 24px 72px;max-width:1060px;margin:0 auto}
.kicker{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.17em;text-transform:uppercase;color:var(--accent)}
.pill{display:inline-block;border:1px solid var(--hair);border-radius:999px;padding:4px 12px;font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;color:var(--soft);vertical-align:middle}
.pill.live{color:var(--ok);border-color:rgba(110,231,160,.35)}
.pill.warn{color:var(--accent);border-color:rgba(242,163,60,.4)}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:34px}
h1{font-size:13px;font-weight:700;letter-spacing:.05em}
.hero{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--hair);border:1px solid var(--hair);margin-bottom:36px}
.hero .cell{background:var(--surface);padding:22px 24px}
.num{font-size:44px;font-weight:800;letter-spacing:-.03em;line-height:1.05;font-variant-numeric:tabular-nums}
.lbl{font:600 10px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--soft)}
h2{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.17em;text-transform:uppercase;color:var(--soft);margin:38px 0 16px}
.modes{display:grid;gap:18px}
.mode{display:grid;grid-template-columns:120px 1fr 110px;gap:16px;align-items:center}
.mode .name{font:700 13px/1.2 Archivo,system-ui,sans-serif;letter-spacing:.06em}
.mode .seats{font:600 11px/1.2 ui-monospace,Menlo,monospace;color:var(--soft);text-align:right}
.track{position:relative;height:26px;background:repeating-linear-gradient(90deg,rgba(142,142,160,.22) 0 1px,transparent 1px 9px);border:1px solid var(--hair)}
.fill{position:absolute;inset:1px auto 1px 1px;background:linear-gradient(90deg,rgba(242,163,60,.85),var(--accent));min-width:0}
.fill.degraded{background:repeating-linear-gradient(45deg,rgba(142,142,160,.5) 0 4px,transparent 4px 8px)}
.dot{position:absolute;top:50%;width:9px;height:9px;border-radius:50%;background:var(--accent);transform:translate(4px,-50%);box-shadow:0 0 0 3px rgba(242,163,60,.2)}
.dot.degraded{background:var(--soft);box-shadow:0 0 0 3px rgba(142,142,160,.18)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--soft);text-align:left;padding:0 12px 10px 0}
td{padding:10px 12px 10px 0;border-top:1px solid var(--hair);font-size:14px}
.mono{font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em}
.lat-good{color:var(--accent)}.lat-mid{color:var(--ink)}.lat-far{color:var(--soft)}
.hdot{display:inline-block;width:9px;height:9px;border-radius:50%}
.hdot.ok{background:var(--ok)}.hdot.warn{background:var(--accent)}.hdot.bad{background:var(--bad)}
.cellbar{display:inline-block;width:110px;height:10px;position:relative;background:repeating-linear-gradient(90deg,rgba(142,142,160,.22) 0 1px,transparent 1px 7px);border:1px solid var(--hair);vertical-align:middle}
.cellbar i{position:absolute;inset:1px auto 1px 1px;background:var(--accent)}
.empty{color:var(--soft);font-size:14px;padding:18px 0}
.geos{display:grid;gap:14px}
.geo{display:grid;grid-template-columns:120px 1fr 170px;gap:16px;align-items:center;font-size:14px}
.footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--hair);color:var(--soft);font-size:12.5px}
.footer a{color:var(--soft)}
@media(max-width:720px){.hero{grid-template-columns:1fr}.mode{grid-template-columns:80px 1fr}.mode .seats{display:none}.num{font-size:36px}}
</style></head><body>
<header><span class="kicker">NETWORK &middot; LIVE</span><span class="pill warn" id="conn">CONNECTING</span></header>
<div class="hero">
	<div class="cell"><div class="num" id="t-players">0</div><div class="lbl">players in match</div></div>
	<div class="cell"><div class="num" id="t-matches">0</div><div class="lbl">active matches</div></div>
	<div class="cell"><div class="num" id="t-free">0</div><div class="lbl">free slots</div></div>
</div>
<h2>Slots by mode</h2>
<div class="modes">
	<div class="mode"><div class="name">1V1</div><div class="track" id="m1"></div><div class="seats" id="m1s">0 seats</div></div>
	<div class="mode"><div class="name">2V2 / 4P</div><div class="track" id="m4"></div><div class="seats" id="m4s">0 seats</div></div>
</div>
<h2>Nodes</h2>
<table><thead><tr><th>node</th><th>geo</th><th>matches</th><th>players</th><th>latency</th><th>health</th><th>reconnects</th></tr></thead><tbody id="nodes"></tbody></table>
<h2>Totals</h2>
<div class="modes">
	<div class="mode"><div class="name">Games started</div><div class="num" id="t-games" style="font-size:30px">0</div><div class="seats" id="t-uptime"></div></div>
</div>
<div style="height:22px"></div>
<div class="geos" id="geos"></div>
<div class="footer">SteelSeed spine &middot; anonymous per-node data (geo only) &middot; <a href="/nodes">/nodes json</a> &middot; <a href="/events">/events sse</a></div>
<script>
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtUptime = ms => {
	if (!Number.isFinite(ms) || ms < 0) return '';
	const s = Math.floor(ms / 1000), d = Math.floor(s / 86400);
	const h = String(Math.floor(s % 86400 / 3600)).padStart(2, '0');
	const m = String(Math.floor(s % 3600 / 60)).padStart(2, '0');
	return (d ? d + 'd ' : '') + h + ':' + m + ':' + String(s % 60).padStart(2, '0');
};
function bar(track, used, total, degraded) {
	const pct = total > 0 ? Math.min(100, used / total * 100) : 0;
	const dpct = total > 0 ? Math.min(100 - pct, degraded / total * 100) : 0;
	track.innerHTML = '<div class="fill" style="width:' + pct.toFixed(1) + '%"></div>' +
		(degraded > 0 ? '<div class="fill degraded" style="left:calc(' + pct.toFixed(1) + '% + 1px);width:' + dpct.toFixed(1) + '%"></div>' : '') +
		'<div class="dot' + (degraded > 0 ? ' degraded' : '') + '" style="left:' + pct.toFixed(1) + '%"></div>';
}
function render(j) {
	const t = j.totals || {};
	$('t-players').textContent = t.players ?? 0;
	$('t-matches').textContent = t.matches ?? 0;
	$('t-free').textContent = t.freeSlots ?? 0;
	$('t-games').textContent = t.gamesStarted ?? 0;
	$('t-uptime').textContent = 'spine uptime ' + fmtUptime(t.uptimeMs);
	const modes = { one: 0, oneSeats: 0, four: 0, fourSeats: 0, fourDegraded: 0 };
	for (const n of j.nodes || []) {
		const free = n.freeMatches ?? 0;
		modes.one += free; modes.oneSeats += free * 2;
		if ((n.maxPlayersPerMatch ?? 8) >= 4) {
			if (n.degraded) { modes.fourDegraded += free; modes.fourSeats += free * 4; }
			else { modes.four += free; modes.fourSeats += free * 4; }
		}
	}
	const scale = Math.max(modes.one + modes.fourDegraded, modes.four, 1);
	bar($('m1'), modes.one, scale, 0);
	bar($('m4'), modes.four, scale, modes.fourDegraded);
	$('m1s').textContent = modes.oneSeats + ' seats';
	$('m4s').textContent = modes.fourSeats + ' seats';
	const rows = (j.nodes || []).map(n => {
		const lat = n.latencyMs == null ? '&mdash;' : Math.round(n.latencyMs) + ' ms';
		const latCls = n.latencyMs == null ? 'lat-far' : (n.latencyMs < 80 ? 'lat-good' : n.latencyMs < 200 ? 'lat-mid' : 'lat-far');
		const health = n.degraded ? 'warn' : (n.healthy ? 'ok' : 'bad');
		const used = n.matches > 0 ? Math.round((n.rooms ?? 0) / n.matches * 100) : 0;
		return '<tr><td class="mono">' + esc(n.id) + '</td><td>' + esc(n.geo || '&mdash;') + '</td>' +
			'<td><span class="cellbar"><i style="width:' + used + '%"></i></span> <span class="mono">' + (n.rooms ?? 0) + '/' + (n.matches ?? 0) + '</span></td>' +
			'<td>' + (n.players ?? 0) + '</td><td class="' + latCls + '">' + lat + '</td>' +
			'<td><span class="hdot ' + health + '"></span> <span class="mono">' + (n.degraded ? 'DEGRADED' : n.healthy ? 'HEALTHY' : 'UNLOADED') + '</span></td>' +
			'<td>' + (n.reconnects ?? 0) + '</td></tr>';
	});
	$('nodes').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="7" class="empty">No nodes connected. A node appears here the moment its roomhost dials this spine.</td></tr>';
	const geos = (j.byGeo || []).slice().sort((a, b) => (b.games || 0) - (a.games || 0));
	const gmax = Math.max(1, ...geos.map(g => g.games || 0));
	$('geos').innerHTML = geos.length ? geos.map(g =>
		'<div class="geo"><div class="mono">' + esc(g.geo || '?') + '</div>' +
		'<div class="track" style="height:18px"><div class="fill" style="width:' + ((g.games || 0) / gmax * 100).toFixed(1) + '%"></div></div>' +
		'<div class="seats">' + (g.games || 0) + ' games &middot; ' + (g.latencyAvgMs == null ? '&mdash;' : g.latencyAvgMs + ' ms avg') + '</div></div>'
	).join('') : '<div class="empty">No games recorded yet.</div>';
}
const es = new EventSource('/events');
es.onopen = () => { $('conn').textContent = 'LIVE'; $('conn').className = 'pill live'; };
es.onerror = () => { $('conn').textContent = 'RECONNECTING'; $('conn').className = 'pill warn'; };
es.onmessage = e => { try { render(JSON.parse(e.data)); } catch {} };
</script></body></html>`;

const httpServer = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://spine.invalid');
	// CORS (§5.2): the Origin is echoed only when it is one of the site
	// origins or a loopback origin — never `*`, never for a foreign origin.
	applyCors(req, res);
	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	if (url.pathname === '/v2/ranked/provision' && req.method === 'POST') {
		// This endpoint is for the account service only. It is intentionally not
		// CORS-enabled and never accepts browser credentials or public room data.
		if (typeof req.headers.origin === 'string' && req.headers.origin !== '') {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'provision-service-only' }));
			return;
		}
		if (!rankedProvisionAuthorized(req)) {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'provision-auth-required' }));
			return;
		}
		if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') {
			res.writeHead(415, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'content-type must be application/json' }));
			return;
		}
		let body;
		try { body = JSON.parse((await readBody(req)) || '{}'); }
		catch {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid-json' }));
			return;
		}
		if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.mapUid !== 'string' ||
			!/^[0-9a-f]{40}$/.test(body.mapUid) || (body.slots !== undefined &&
			(!Number.isInteger(body.slots) || body.slots < 2 || body.slots > 5)) ||
			(body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 1 || body.idempotencyKey.length > 128))) {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid', field: 'mapUid-slots-or-idempotencyKey' }));
			return;
		}
		const idempotencyKey = body.idempotencyKey;
		if (idempotencyKey) {
			const priorHash = rankedProvisionIdempotency.get(idempotencyKey);
			const prior = priorHash && rankedReservations.get(priorHash);
			if (prior && prior.expiresAt > Date.now()) {
				const { idempotencyKey: _priorKey, ...publicPrior } = prior;
				res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
				res.end(JSON.stringify({ schema: 1, ...publicPrior, wsUrl: wsUrlFor(prior.roomId), reservationTtlMs: rankedProvisionTtlMs }));
				return;
			}
			if (priorHash) rankedProvisionIdempotency.delete(idempotencyKey);
		}
		const owner = placementCandidates(body.geo, true)[0];
		const rulesHash = owner?.rulesHash || rankedRulesHash;
		if (!owner || typeof owner.build !== 'string' || owner.build === '' || typeof rulesHash !== 'string' || !/^[0-9a-f]{64}$/.test(rulesHash)) {
			res.writeHead(503, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'no-ranked-owner-capacity' }));
			return;
		}
		let roomId;
		do { roomId = crypto.randomBytes(8).toString('hex'); } while (placedRooms.has(roomId) || [...rankedReservations.values()].some(r => r.roomId === roomId));
		const hostKey = randomHostKey();
		const reservation = {
			nodeId: owner.id, roomId, hostKey, mapUid: body.mapUid, slots: body.slots ?? 2,
			simBuild: owner.build, rulesHash, expiresAt: Date.now() + rankedProvisionTtlMs,
			...(idempotencyKey ? { idempotencyKey } : {}),
		};
		rankedReservations.set(hostKeyHash(hostKey), reservation);
		if (idempotencyKey) rankedProvisionIdempotency.set(idempotencyKey, hostKeyHash(hostKey));
		const { idempotencyKey: _reservationKey, ...publicReservation } = reservation;
		res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify({ schema: 1, ...publicReservation, wsUrl: wsUrlFor(roomId), reservationTtlMs: rankedProvisionTtlMs }));
		return;
	}

	if (url.pathname === '/v2/rooms' && req.method === 'POST') {
		// Placement is opt-in: ordinary local/standing rooms still originate at
		// the node and never pass through this path.
		if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') {
			res.writeHead(415, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'content-type must be application/json' }));
			return;
		}
		const origin = req.headers.origin;
		const hasOrigin = typeof origin === 'string' && origin !== '';
		const loopbackOrigin = isLoopbackOrigin(origin);
		const siteOrigin = hasOrigin && config.siteOrigins.includes(origin);
		const serviceAuthorized = rankedProvisionAuthorized(req);
		// T6.4: ordinary placement is a browser operation, so it must carry an
		// exact allowlisted (or loopback) Origin. The account service is the one
		// no-Origin exception, authenticated by its ranked provision bearer; it
		// may only use that exception for a ranked finalization below.
		if ((hasOrigin && !loopbackOrigin && !siteOrigin) || (!hasOrigin && !serviceAuthorized)) {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'origin-not-allowed' }));
			return;
		}
		if (draining) {
			res.writeHead(503, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'draining' }));
			return;
		}
		// Production can keep the public runtime switch off while allowing the
		// owner's deliberately obscure `?debug=on` rollout path. This is a gate,
		// not authentication: placement retains its IP/capacity limits. Missing
		// Origin is gated too, so removing the browser header cannot bypass off.
		const privateDebugPlacement = config.debugMultiplayer === true && url.searchParams.get('debug') === 'on';
		if (config.browserMultiplayer !== 'full' && siteOrigin && !privateDebugPlacement) {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'browser-multiplayer-off' }));
			return;
		}
		if (config.placement !== 'donated' && config.placement !== 'donated+owner') {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'placement-disabled' }));
			return;
		}
		let body;
		try { body = JSON.parse((await readBody(req)) || '{}'); }
		catch {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid-json' }));
			return;
		}
		if (!body || typeof body !== 'object' || Array.isArray(body) ||
			typeof body.map !== 'string' || !/^[0-9a-f]{40}$/.test(body.map) ||
			(body.slots !== undefined && (!Number.isInteger(body.slots) || body.slots < 2 || body.slots > 5))) {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid', field: 'map-or-slots' }));
			return;
		}
		if (body.ranked === true && !serviceAuthorized) {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'ranked-service-auth-required' }));
			return;
		}
		if (body.ranked !== true && !hasOrigin) {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'origin-not-allowed' }));
			return;
		}
		// Room placement is expensive (spawns a dedicated). Per-IP rate limit:
		// the one real client need is a host clicking once; faster is abuse.
		const clientKey = ipKey(clientIpOf(req));
		const livePlaced = placedIpRooms.get(clientKey);
		if (livePlaced && placedRooms.has(livePlaced)) {
			res.writeHead(429, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'one-room-per-ip' }));
			return;
		}
		const now = Date.now();
		const budget = consumeCreateBudget(createRate, clientKey, now, createRateWindowMs, createRateLimit);
		if (!budget.allowed) {
			const retryAfter = Math.max(1, Math.ceil(budget.retryAfterMs / 1000));
			res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfter) });
			res.end(JSON.stringify({ error: 'rate' }));
			return;
		}
		body.slots ??= 2;
		const hostKey = body.ranked === true ? body.hostKey : randomHostKey();
		if (body.ranked === true && (typeof hostKey !== 'string' || !/^[0-9a-f]{32}$/.test(hostKey))) {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'ranked-host-key-required' }));
			return;
		}
		let rankedAdmission = null;
		let rankedReservation = null;
		if (body.ranked === true) {
			if (config.placement !== 'donated+owner') {
				res.writeHead(403, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'ranked-owner-only' }));
				return;
			}
			rankedReservation = rankedReservations.get(hostKeyHash(hostKey));
			if (!rankedReservation || rankedReservation.expiresAt <= Date.now() || rankedReservation.hostKey !== hostKey) {
				res.writeHead(403, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'ranked-provision-required' }));
				return;
			}
			rankedAdmission = verifyRankedAdmission(body, hostKey);
			if (rankedAdmission.error) {
				res.writeHead(403, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: rankedAdmission.error }));
				return;
			}
			if (rankedAdmission.roomClaim.nodeId !== rankedReservation.nodeId || rankedAdmission.roomClaim.roomId !== rankedReservation.roomId ||
				rankedAdmission.roomClaim.mapUid !== rankedReservation.mapUid || rankedAdmission.roomClaim.simBuild !== rankedReservation.simBuild ||
				rankedAdmission.roomClaim.rulesHash !== rankedReservation.rulesHash) {
				res.writeHead(403, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'ranked-provision-mismatch' }));
				return;
			}
			body.roomId = rankedAdmission.roomClaim.roomId;
			body.map = rankedAdmission.roomClaim.mapUid;
			body.hostKey = hostKey;
		}
		const allowOwner = ordinaryOwnerAllowed();
		const candidates = body.ranked === true
			? placementCandidates(body.geo, true).filter(node => node.id === rankedAdmission.roomClaim.nodeId)
			: placementPool(body.geo, allowOwner);
		for (const node of candidates) {
			try {
				const created = await createRoomOnNode(node, { ...body, hostKey });
				if (rankedReservation && created.roomId !== rankedReservation.roomId)
					throw new Error('owner returned a different reserved roomId');
				const access = {
					hostKey: created.hostKey,
					hostKeyHash: hostKeyHash(created.hostKey),
					ranked: body.ranked === true,
					participantClaims: body.participantClaims ?? [],
					consumedClaims: new Set(),
					ipKey: clientKey,
					roomClaim: rankedAdmission?.roomClaim ?? null,
				};
				placedRooms.set(created.roomId, access);
				if (rankedReservation) {
					rankedReservations.delete(hostKeyHash(rankedReservation.hostKey));
					if (rankedReservation.idempotencyKey) rankedProvisionIdempotency.delete(rankedReservation.idempotencyKey);
				}
				if (!body.ranked) placedIpRooms.set(clientKey, created.roomId);
				const summary = created.summary;
				res.writeHead(201, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ room: {
					roomId: created.roomId,
					name: summary.name ?? body.name ?? 'Room',
					map: { uid: summary.mapUid ?? body.map, title: summary.mapTitle ?? '' },
					slots: summary.slots ?? body.slots,
					players: summary.players ?? 0,
					state: 'booting',
					locked: !!body.password,
					build: node.build,
					hostKind: node.tier === 'owner' ? 'owner' : 'donated',
					wsUrl: wsUrlFor(created.roomId),
					...(body.ranked ? {} : { hostKey: created.hostKey }),
				} }));
				return;
			} catch (error) {
				console.error(`[spine] placement candidate ${node.id} failed: ${error.message}`);
			}
		}
		res.writeHead(503, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'no-capacity' }));
		return;
	}

	if (url.pathname === '/rooms' && req.method === 'POST') {
		// Legacy create (T2.2): the /v2 world hosts rooms on the NODE, not
		// through the directory; old builds get a machine-readable upgrade hint.
		res.writeHead(410, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'upgrade' }));
		return;
	}

	if (url.pathname === '/v2/config' && req.method === 'GET') {
		const free = nodesForCapacity => nodesForCapacity.reduce((total, node) => total + nodeStatus(node).freeMatches, 0);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({
			schema: 1,
			acceptedBuilds: config.acceptedBuilds,
			browserMultiplayer: config.browserMultiplayer,
			placement: config.placement,
			capacity: {
				donatedFree: free(placementCandidates('', false)),
				// The shipped client adds donatedFree + ownerFree to decide whether it
				// can offer public hosting, so owner capacity only counts while
				// ordinary rooms may use it; Ranked's owner capacity is reported apart.
				ownerFree: ordinaryOwnerAllowed() ? free(placementCandidates('', true)) : 0,
				rankedOwnerFree: config.placement === 'donated+owner' ? free(placementCandidates('', true)) : 0,
			},
			draining,
			app: { latest: config.app.latest, downloadUrl: config.app.downloadUrl },
		}));
		return;
	}

	if (url.pathname === '/v2/rooms' && req.method === 'GET') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({
			schema: 1,
			now: Date.now(),
			rooms: listedRooms().map(v2Room),
		}));
		return;
	}

	if (url.pathname === '/rooms' && req.method === 'GET') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(listedRooms().map(legacyRoomRow)));
		return;
	}

	if (url.pathname === '/nodes' && req.method === 'GET') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(liveNodes().filter(n => n.registered).map(n => ({ id: n.id, geo: n.geo, capacity: n.capacity, rooms: n.rooms.size }))));
		return;
	}
	if (url.pathname === '/network' && req.method === 'GET') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(NETWORK_HTML);
		return;
	}


	if (url.pathname === '/events' && req.method === 'GET') {
		// Server-sent events: 1 Hz frames of networkSnapshot(). EventSource
		// reconnects on its own; retry hints 3 s. No auth: anonymous read-only.
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		});
		res.write('retry: 3000\n\n');
		res.write(`data: ${JSON.stringify(networkSnapshot())}\n\n`);
		const frameTimer = setInterval(() => {
			try { res.write(`data: ${JSON.stringify(networkSnapshot())}\n\n`); } catch { /* closed */ }
		}, 1_000);
		const beat = setInterval(() => {
			try { res.write(': ping\n\n'); } catch { /* closed */ }
		}, 15_000);
		res.on('close', () => { clearInterval(frameTimer); clearInterval(beat); });
		return;
	}

	if (req.method === 'GET' && serveBundle) {
		// --serve-bundle (gates only): serve the composed bundle so players
		// only need the spine's address. Production serves no bundle (§5.2).
		// The page graph spans the bundle root (steelseed/index.html imports
		// ../main.js, which imports ./_framework/*), so any GET path that
		// resolves inside the bundle is served; API routes above already ran.
		const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
		// resolve() then a root check: ../ tricks must never escape the bundle.
		const file = path.resolve(bundleDir, rel === '' ? 'index.html' : rel);
		try {
			if (!file.startsWith(bundleDir + path.sep)) throw new Error('outside bundle');
			const stat = fs.statSync(file);
			if (!stat.isFile()) throw new Error('not a file');
			res.writeHead(200, {
				'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
				'content-length': stat.size,
				'cache-control': 'no-cache',
			});
			fs.createReadStream(file).pipe(res);
			return;
		} catch { /* fall through to 404 below */ }
	}


	res.writeHead(404, { 'content-type': 'text/plain' });
	res.end('not found');
});


function routePlayerWs(roomId, req, socket, head) {
	const query = new URL(req.url, 'http://127.0.0.1').searchParams;
	const access = placedRooms.get(roomId) ?? null;
	const roomOwnerNode = nodes.get(roomOwner.get(roomId) ?? '');
	const reportedRoom = roomOwnerNode?.rooms.get(roomId);
	// A placement exists locally before the node's first rooms report. Treat
	// that gap as reserved so a guessed key cannot open the booting room.
	const roomState = reportedRoom?.state ?? (access ? 'reserved' : 'lobby');
	const hostKey = query.get('k') ?? '';
	const claim = query.get('claim') ?? '';
	if (access && !access.ranked && roomState === 'reserved' && hostKey !== access.hostKey) {
		wss.handleUpgrade(req, socket, head, playerWs => closeRelayWs(playerWs, 4404, protocol.playerCloseCodes['4404'].reason));
		return;
	}
	if (access?.ranked) {
		if (!claim || !access.participantClaims.includes(claim) || access.consumedClaims.has(claim)) {
			wss.handleUpgrade(req, socket, head, playerWs => closeRelayWs(playerWs, 4404, protocol.playerCloseCodes['4404'].reason));
			return;
		}
		access.consumedClaims.add(claim);
	}
	wss.handleUpgrade(req, socket, head, playerWs => {
		const owner = nodes.get(roomOwner.get(roomId) ?? '');
		if (!owner || owner.ws.readyState !== WebSocket.OPEN) {
			playerWs.close(1011, 'room not available');
			return;
		}
		// Caps (L11/§5.5): 2000 channels relay-wide, 16 per node — saturation is
		// refused with 1013; 8 player sockets per ipKey with 4429.
		if (players.size >= limits.maxChannels || owner.channelCount >= limits.maxChannelsPerNode) {
			playerWs.close(1013, protocol.playerCloseCodes['1013'].reason);
			return;
		}
		const peerKey = ipKey(clientIpOf(req));
		let peerSockets = 0;
		for (const player of players.values())
			if (player.ipKey === peerKey) peerSockets++;
		if (peerSockets >= limits.maxPlayerSocketsPerIp) {
			playerWs.close(4429, protocol.playerCloseCodes['4429'].reason);
			return;
		}
		// u16 channel id: monotonic, skipping live ids and 0, wrapping at 65535
		// (T1.24) — writeUInt16BE can never overflow and kill the process.
		let chanId = nextChanId % 65535;
		while (chanId === 0 || players.has(chanId)) chanId = chanId % 65535 + 1;
		nextChanId = (chanId % 65535) + 1;
		const writer = createWsWriter(playerWs, {
			limitBytes: 4 * 1024 * 1024,
			onFailure: error => dropPlayer(chanId, true,
				error.code === 'ERR_RELAY_BACKPRESSURE' ? 1013 : 1011,
				error.code === 'ERR_RELAY_BACKPRESSURE' ? 'relay backpressure' : 'relay closed'),
		});
		players.set(chanId, {
			// `node` is the tunnel this channel rides; a reconnect gives the same
			// nodeId a new tunnel, so teardown follows the object, not the id.
			ws: playerWs, writer, nodeId: owner.id, node: owner, roomId, ipKey: peerKey,
			hostKey: access?.hostKey ?? '', claim,
			rate: { in: newChannelBucket(), out: newChannelBucket() },
		});
		owner.channelCount++;
		console.log(`[spine] player chan ${chanId} -> room ${roomId} on node ${owner.id}`);

		beatWs(playerWs);
		playerWs.on('pong', () => wsPong(playerWs));
		playerWs.on('message', (data, isBinary) => {
			if (!players.has(chanId)) return;
			// player -> node half of the per-channel token bucket (L11)
			if (!spendChannelBytes(players.get(chanId), 'in', data.length)) {
				dropPlayer(chanId, true, 4008, protocol.relayCloseCodes['4008'].reason);
				return;
			}
			const frame = Buffer.allocUnsafe(2 + data.length);
			frame.writeUInt16BE(chanId, 0);
			data.copy(frame, 2);
			tunnelWriters.get(owner.ws)?.send(frame, { binary: true });
		});
		playerWs.on('close', () => dropPlayer(chanId));
		playerWs.on('error', () => dropPlayer(chanId, true, 1011, 'relay closed'));
		sendJson(owner.ws, { t: 'open', chanId, roomId, hostKey, claim });
	});
}

httpServer.listen(dirPort, '127.0.0.1', () => {
	console.log(`[spine] directory http://127.0.0.1:${dirPort}/v2/config  (rooms: /v2/rooms, nodes: /nodes)`);
});
const wsListen = http.createServer((req, res) => {
	res.writeHead(426, { 'content-type': 'text/plain' });
	res.end('websocket upgrade required');
});
wsListen.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url ?? '/', 'http://spine.invalid');
	if (url.pathname === '/node') {
		// Nodes are native/service clients and never send Origin. Refusing every
		// browser-origin tunnel prevents a hostile page from consuming the open
		// registration/IP budgets through a cross-site WebSocket.
		if (typeof req.headers.origin === 'string' && req.headers.origin !== '') {
			socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
			socket.destroy();
			return;
		}
		if (draining) {
			// Draining refuses new nodes (§10.4): complete the handshake, then
			// hand the client the 4005 close code.
			wss.handleUpgrade(req, socket, head, ws => closeRelayWs(ws, 4005, protocol.relayCloseCodes['4005'].reason));
			return;
		}
		wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
		return;
	}
	const match = /^\/g\/([0-9a-f]{16})$/.exec(url.pathname);
	if (match) {
		const origin = req.headers.origin;
		const nativeClient = origin === undefined || origin === '';
		const loopback = isLoopbackOrigin(origin);
		const site = typeof origin === 'string' && config.siteOrigins.includes(origin);
		const privateDebugJoin = site && config.debugMultiplayer === true && url.searchParams.get('debug') === 'on';
		const browserAllowed = loopback || (site && (config.browserMultiplayer === 'join' || config.browserMultiplayer === 'full' || privateDebugJoin));
		if (!nativeClient && !browserAllowed) {
			wss.handleUpgrade(req, socket, head, ws => closeRelayWs(ws, 4403, protocol.playerCloseCodes['4403'].reason));
			return;
		}
		const roomId = match[1];
		const owner = nodes.get(roomOwner.get(roomId) ?? '');
		if (!owner || owner.ws.readyState !== WebSocket.OPEN) {
			// Room unknown or ended (§5.6): the upgrade completes so the client
			// receives the 4404 close code instead of a raw HTTP error.
			wss.handleUpgrade(req, socket, head, ws => closeRelayWs(ws, 4404, protocol.playerCloseCodes['4404'].reason));
			return;
		}
		routePlayerWs(roomId, req, socket, head);
		return;
	}
	console.log(`[spine] upgrade rejected: path=${url.pathname} knownRooms=${[...nodes.values()].flatMap(n => [...n.rooms.keys()]).join(',')}`);
	socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
	socket.destroy();
});
wsListen.listen(relayWsPort, '127.0.0.1', () => {
	console.log(`[spine] node tunnels + player ws on ws://127.0.0.1:${relayWsPort}`);
});
