// SteelSeed room host — the same-network helper (PR 3) and internet room
// spine (PR 4, --spine). One process provides:
//
//   HTTP  — static serving of the composed AppBundle (so LAN pages avoid
//           mixed content) plus the /v2 room API (§5.3):
//             POST /v2/rooms {map, slots, ...} -> 201 {room:{roomId, wsUrl, state}}
//             GET  /v2/rooms                  -> {schema, rooms:[...]}
//   WS    — upgrade on /g/<roomId> pumps bytes to that room's dedicated server
//           TCP port (relay semantics: NoDelay, pending buffer, closeBoth
//           per connection, zero protocol awareness).
//
// Each room spawns a fresh authoritative dedicated server on
// 127.0.0.1:<base-port+n> and deletes the room when the dedicated exits.
// --public mode hardens the directory: WS upgrade origin allowlist, per-IP
// token bucket on POST /rooms, strict max-matches.
//
// T1.0: this file exports `parseArgv()` (the baseline argv parsing) and
// `startNode(options)` (the whole boot). `node-cli.mjs` is the shipped entry
// point; running this file directly still calls startNode(parseArgv()), so
// every gate keeps its command line.
//
// Usage:
//   node roomhost.mjs [options]      (baseline defaults, gate compatibility)
//   node node-cli.mjs [options]      (shipped CLI: protocol ports, key handling)
//     --ws <port>          WebSocket mux port        (default 8322)
//     --http <port>        static/dir HTTP port      (default 8331, 0 = pick one)
//     --dedicated <path>   launcher to spawn         (default ../launch-dedicated.sh)
//     --base-port <n>      first dedicated port      (default 13400)
//     --max-matches <n>    concurrent room cap       (default 2)
//     --public             internet-spine hardening mode (PR 4)
//     --origin <url>       allowed WS Origin in --public mode (repeatable)
//     --host <addr>        bind address for both servers (default 127.0.0.1)
//     --mode <mode>        own | standing | donate  (default own; standing = T3.19)
//     --rooms-file <file>  standing rooms file (§5.4), required with --mode standing
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createTcpWriter, createWsWriter } from './relay-flow.mjs';
import { resolveRunner, buildArgs, RunnerMissing, killTree } from './dedicated-runner.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { startAnnouncer, GROUP, PORT } from './lan-beacon.mjs';
import { rankedObserveServerBytes } from './ranked-binding.mjs';
import { roomLifecycleExpiry } from './placement-policy.mjs';

const RELAY_LIMITS = { tcp: 4 * 1024 * 1024, ws: 4 * 1024 * 1024, tunnel: 16 * 1024 * 1024 };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(scriptDir, '../..');
// L11/L12/L13/L16/L17 constants live in protocol.json — no magic numbers here.
const protocol = JSON.parse(fs.readFileSync(path.join(scriptDir, 'protocol.json'), 'utf8'));

function closeRelayWs(ws, code, reason) {
	if (ws.readyState === WebSocket.CLOSED) return;
	const timer = setTimeout(() => {
		if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
	}, 1000).unref();
	ws.once('close', () => clearTimeout(timer));
	try { ws.close(code, reason); } catch { ws.terminate(); }
}

// The dedicated server needs OS/runtime paths and the mod path, but never
// authenticates to the relay. An allowlist also excludes credentials whose
// names do not happen to contain TOKEN or SECRET (e.g. AWS_ACCESS_KEY_ID).
const DEDICATED_ENV_KEYS = [
	'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE', 'SystemRoot', 'WINDIR',
	'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
	'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
	'DOTNET_ROOT', 'DOTNET_BUNDLE_EXTRACT_BASE_DIR', 'DOTNET_SYSTEM_GLOBALIZATION_INVARIANT',
	'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
	'SSL_CERT_FILE', 'SSL_CERT_DIR',
	'REDLINE_NODE_FIXTURE_RUNNER', // the local node-test harness only
];
export function dedicatedServerEnv(parentEnv, modSearchPaths) {
	const env = {};
	for (const key of DEDICATED_ENV_KEYS)
		if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
	env.MOD_SEARCH_PATHS = modSearchPaths;
	env.REDLINE_BIND = 'loopback';
	return env;
}

// ---- baseline argv parsing (T1.0) ----
// The flags roomhost.mjs has always taken, packaged. node-cli.mjs layers the
// shipped CLI surface (env names, protocol ports, node key) on top of this.
// The node's display name becomes every room's hostName in the public room
// list, so without an explicit --name it is a neutral label, never the
// machine's hostname.
export function publicNodeName(name) {
	return typeof name === 'string' && name.trim() !== ''
		? name.trim().slice(0, protocol.nodeTunnel.nodeNameMaxChars)
		: 'Redline host';
}

export function parseArgv(argv = process.argv.slice(2)) {
	const value = (name, fallback) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
	};
	const values = name => {
		const out = [];
		for (let i = 0; i < argv.length; i++)
			if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
		return out;
	};
	const has = name => argv.includes(name);
	// T1.9 removed flags: refuse loudly so old start scripts cannot silently
	// run an unhardened node. --dedicated stays as a logged no-op (T1.1).
	const removed = {
		'--host': 'the HTTP API always listens on 127.0.0.1; --lan widens only the WS mux',
		'--public': 'the local API is always hardened; use --lan for the LAN mux',
		'--origin': 'origin allowlists are gone: CORS echoes loopback origins only',
		'--geo': 'the geo tag moved to the relay-side node registry',
		'--token': 'secrets never travel on argv; set REDLINE_NODE_TOKEN in the environment',
	};
	for (let i = 0; i < argv.length; i++) {
		if (removed[argv[i]]) throw new Error(`roomhost: ${argv[i]} was removed — ${removed[argv[i]]}`);
		if (argv[i] === '--dedicated') console.log('[roomhost] --dedicated is ignored (the node starts the server binary directly, T1.1)');
	}
	return {
		muxPort: Number(value('--ws', '8322')),
		httpPort: Number(value('--http', '8331')),
		basePort: Number(value('--base-port', String(protocol.ports.dedicatedBase))),
		maxMatches: Number(value('--max-matches', '2')),
		idleKillSeconds: Number(value('--idle-kill', String(protocol.timeouts.idleKillDefaultSeconds))),
		bundle: value('--bundle', null),
		spineUrl: value('--spine', null),
		dataDir: value('--data-dir', null),
		mode: value('--mode', undefined),
		roomsFile: value('--rooms-file', undefined),
		lan: has('--lan'),
		debugSync: has('--debug-sync'),
		exitOnDrain: has('--exit-on-drain'),
		// T2.9: only the version gate may skip the build.json verification —
		// and only when REDLINE_GATE=1 (startNode refuses otherwise).
		skipBuildCheck: has('--skip-build-check'),
	};
}

const STATUS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>SteelSeed node - status</title>
<style>body{background:#0b0e10;color:#d6e0df;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:24px}
h1{font-size:18px}table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #23313a;padding:4px 10px;text-align:left}
#log{background:#050708;border:1px solid #23313a;padding:10px;max-height:45vh;overflow:auto;white-space:pre-wrap}
.ok{color:#7dd487}.bad{color:#ff795a}</style></head><body>
<h2>Rooms</h2><table><tr><th>room</th><th>map</th><th>port</th><th>players</th><th>dedicated</th></tr><tbody id="rooms"></tbody></table>
<h2>Log</h2><div id="log"></div>
<script>
const tick = async () => {
	const j = await (await fetch('/status.json')).json();
	const sp = document.getElementById('spine');
	sp.textContent = j.spine ? (j.spine.connected ? 'verbonden met spine' : 'spine VERBROKEN') : 'standalone (geen spine)';
	sp.className = j.spine && j.spine.connected ? 'ok' : 'bad';
	document.getElementById('meta').textContent = 'uptime ' + Math.round(j.uptimeMs / 1000) + 's - geo ' + (j.geo || '-') + ' - kanalen ' + j.channels;
	const tb = document.getElementById('rooms');
	tb.replaceChildren();
	for (const r of j.rooms) {
		const tr = document.createElement('tr');
		for (const v of [r.roomId.slice(0, 10), r.map.slice(0, 14), r.port, r.players, r.dedicatedAlive ? 'draait' : 'gestopt']) {
			const td = document.createElement('td'); td.textContent = v; tr.append(td);
		}
		tb.append(tr);
	}
	document.getElementById('log').textContent = j.log.join('\\n');
};
tick(); setInterval(tick, 2000);
</script></body></html>`;

// T1.6 orphan-sweep helpers. pids are reused: a leftover pidfile only earns a
// kill when the process is alive AND its command line is an OpenRA.Server.
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
}

function cmdlineIncludes(pid, needle) {
	try {
		// Linux: /proc is cheap and exact.
		const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
		return raw.split('\0').some(part => part.includes(needle));
	} catch {
		// macOS/BSD: ask ps.
		try {
			const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
			return out.status === 0 && String(out.stdout).includes(needle);
		} catch {
			return false;
		}
	}
}

export async function startNode(options = {}) {
	const muxPort = Number(options.muxPort ?? 8322);
	const httpPort = Number(options.httpPort ?? 8331);
	const basePort = Number(options.basePort ?? protocol.ports.dedicatedBase);
	const maxMatches = Number(options.maxMatches ?? 2);
	const idleKillMs = Math.max(protocol.timeouts.idleKillFloorSeconds * 1000, Number(options.idleKillSeconds ?? protocol.timeouts.idleKillDefaultSeconds) * 1000);
	const debugSync = !!options.debugSync;
	const bundleRoot = path.resolve(options.bundle
		// T3.14 packaging: zip/npm nodes carry AppBundle at the engine root;
		// the dev tree composes into bin-browser/AppBundle.
		?? (fs.existsSync(path.join(engineRoot, 'AppBundle/main.js'))
			? path.join(engineRoot, 'AppBundle')
			: path.join(engineRoot, 'bin-browser/AppBundle')));
	// T1.9: the local API is loopback-only and every mutating request is
	// keyed. The key arrives via env (never argv); whoever starts the node
	// generates it (node-cli.mjs, the desktop shell).
	const nodeKey = options.nodeKey ?? process.env.REDLINE_NODE_KEY ?? null;
	if (!nodeKey) throw new Error('roomhost: REDLINE_NODE_KEY is not set — generate a key or start via node-cli.mjs');
	const spineUrl = options.spineUrl ?? null;
	const spineToken = process.env.REDLINE_NODE_TOKEN ?? process.env.NODE_TOKEN ?? process.env.STEELSEED_SPINE_TOKEN ?? null;
	// T2.5: the node's registration mode (own | standing | donate). `standing`
	// is accepted here from T2.5 on; its room lifecycle lands in T3.19.
	const mode = protocol.nodeModes.includes(options.mode) ? options.mode : 'own';
	// T3.19: a community server is reached through the relay only — the LAN
	// mux and the beacon are refused in standing mode. Standing needs its
	// rooms file; it is validated against the catalog once that has loaded.
	if (mode === 'standing' && options.lan)
		throw new Error('roomhost: --lan is not available in standing mode — a community server is reached through the relay only');
	if (mode === 'standing' && !options.roomsFile)
		throw new Error('roomhost: standing mode requires --rooms-file (§5.4)');
	const nodeName = publicNodeName(options.name);
	// T2.5: the app version advertised at registration; the desktop package's
	// version when this repo carries it, else the dev placeholder.
	let appVersion = '0.0.0-dev';
	try {
		appVersion = JSON.parse(fs.readFileSync(path.join(engineRoot, 'desktop/package.json'), 'utf8')).version ?? appVersion;
	} catch { /* unpackaged tree */ }
	// --lan widens ONLY the WS mux; the HTTP API always listens on 127.0.0.1.
	const muxHost = options.lan ? '0.0.0.0' : '127.0.0.1';
	const apiHost = '127.0.0.1';
	// T2.5: the per-install registration identity (§5.5: base64url, mode 0600),
	// kept separate from the per-launch API key. --node-key-file (node-cli)
	// relocates it; the default lives under --data-dir. Created on first use.
	function ensureInstallKey() {
		const keyPath = path.resolve(options.nodeKeyFile ?? path.join(dataDir, 'node.key'));
		try {
			const stored = fs.readFileSync(keyPath, 'utf8').trim();
			if (stored) return stored;
		} catch { /* not there yet — create it */ }
		const key = crypto.randomBytes(32).toString('base64url');
		fs.mkdirSync(path.dirname(keyPath), { recursive: true });
		fs.writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
		return key;
	}
	// T3.5: the node's stable local identity — 12 hex derived from the
	// per-install registration key. Surfaced on /v2/health (the shell passes
	// it to the LAN listener as --self) and used by the LAN announcer.
	let localNodeId = null;
	function nodeId() {
		if (localNodeId === null)
			localNodeId = crypto.createHash('sha256').update(ensureInstallKey()).digest('hex').slice(0, 12);
		return localNodeId;
	}
	// T1.10: the map catalog is the only room-creation truth. Without it the
	// node would boot random maps on crafted uids — so refuse to run.
	const catalogPath = path.join(engineRoot, 'steelseed-host/generated/mods/ra/map-catalog.json');
	const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
	if (!Array.isArray(catalog) || catalog.length === 0)
		throw new Error(`roomhost: ${catalogPath} must be a non-empty array (run tools/build-ra-mod.mjs)`);
	const catalogByUid = new Map(catalog.map(entry => [entry.uid, entry]));
	const catalogSpeeds = new Set(catalog.flatMap(entry => entry.speeds ?? []));
	// T3.19: standing mode refuses to start without a readable, valid rooms
	// file (§5.4) that fits --max-matches. The entries are booted once the
	// servers listen.
	const standingEntries = mode === 'standing'
		? loadStandingRooms(path.resolve(options.roomsFile), maxMatches)
		: [];
	// T1.2: per-room Engine.SupportDir lives under --data-dir; the default
	// matches the packaged node contract (~/.redline-node).
	const dataDir = path.resolve(options.dataDir ?? path.join(os.homedir(), '.redline-node'));

	// T2.1 step 4: the stamped mod is the only mod this node may launch. The
	// generated build.json records modHash = treeHash(A) over generated/mods/ra
	// at build time; recompute it here and refuse to boot on any difference.
	// --skip-build-check exists ONLY for the version gate (T2.9) and is
	// accepted solely when REDLINE_GATE=1 is set in the environment.
	if (options.skipBuildCheck && process.env.REDLINE_GATE !== '1')
		throw new Error('roomhost: --skip-build-check requires env REDLINE_GATE=1');
	const buildJsonPath = path.join(engineRoot, 'steelseed-host/generated/build.json');
	let buildInfo = null;
	if (fs.existsSync(buildJsonPath)) {
		buildInfo = JSON.parse(fs.readFileSync(buildJsonPath, 'utf8'));
		if (buildInfo?.schema !== 1 || typeof buildInfo?.simBuild !== 'string' || typeof buildInfo?.modHash !== 'string')
			throw new Error(`roomhost: ${buildJsonPath} must be {"schema":1,"simBuild":"…","modHash":"…"}`);
		if (!options.skipBuildCheck) {
			// sim-build-id.mjs's modTreeHash is §5.8 tree A with the stamped
			// mod.yaml Version line blanked — stamp-invariant, exactly the
			// value build.json records. Loaded dynamically so unpackaged
			// fixture trees still boot (verification logs and skips).
			let modTreeHash = null;
			try {
				modTreeHash = (await import('./sim-build-id.mjs')).modTreeHash ?? null;
			} catch {
				console.log('[roomhost] sim-build-id.mjs unavailable — build verification skipped');
			}
			if (modTreeHash) {
				const modDir = path.join(engineRoot, 'steelseed-host/generated/mods/ra');
				if (modTreeHash(modDir) !== buildInfo.modHash)
					throw new Error('mod does not match build.json');
			}
		}
	} else {
		console.log('[roomhost] generated/build.json missing — build verification skipped (run tools/build-ra-mod.mjs)');
	}

	// T1.6: orphan sweep — a crashed node leaves dedicated servers behind.
	// Every leftover <dataDir>/rooms/<id>/server.pid whose process is alive
	// AND is really an OpenRA.Server dies now (pids are reused — never kill
	// on the pid alone); then the stale room directory goes too.
	const sweepOrphanRooms = () => {
		const roomsRoot = path.join(dataDir, 'rooms');
		let entries;
		try { entries = fs.readdirSync(roomsRoot); } catch { return; }
		for (const entry of entries) {
			const dir = path.join(roomsRoot, entry);
			const pidFile = path.join(dir, 'server.pid');
			try {
				const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
				if (Number.isInteger(pid) && pid > 0 && processAlive(pid) && cmdlineIncludes(pid, 'OpenRA.Server')) {
					console.log(`[roomhost] orphan sweep: killing leftover dedicated server ${pid} (${entry})`);
					if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
					else {
						try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
						const escalate = setTimeout(() => {
							try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
						}, 3000);
						escalate.unref();
					}
				}
			} catch { /* unreadable pid file — just clean the directory */ }
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};
	sweepOrphanRooms();

const rooms = new Map(); // roomId -> room
// A donated node can drain safely: it refuses new rooms, lets current rooms
// finish, then exits. This is generic node lifecycle state, not ranked logic.
let draining = false;
const ports = new Set();
const statusLog = [];
const startedAt = Date.now();

// Ranked custody crosses a one-way spool boundary. This process can only drop
// an input job; a separate OS principal claims it, verifies it and owns both
// the signing key and durable settlement outbox.
const rankedInbox = process.env.REDLINE_RANKED_INBOX ?? null;

function writeSpoolFile(file, bytes) {
	const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o640);
	try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	fs.chmodSync(file, 0o640);
}

function enqueueRankedReplay({ replayFile, claim, custody }) {
	if (typeof rankedInbox !== 'string' || rankedInbox === '') throw new Error('REDLINE_RANKED_INBOX is not configured');
	const id = crypto.randomBytes(16).toString('hex');
	const staging = path.join(rankedInbox, `.tmp-${id}-${process.pid}`);
	const complete = path.join(rankedInbox, `${id}.job`);
	fs.mkdirSync(staging, { mode: 0o750 });
	fs.chmodSync(staging, 0o750);
	try {
		writeSpoolFile(path.join(staging, 'job.json'), `${JSON.stringify({ schema: 1, claim, endedAt: custody.endedAt, custody })}\n`);
		if (replayFile) {
			const stat = fs.lstatSync(replayFile);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024) throw new Error('unsafe replay artifact');
			fs.copyFileSync(replayFile, path.join(staging, 'replay.orarep'), fs.constants.COPYFILE_EXCL);
			fs.chmodSync(path.join(staging, 'replay.orarep'), 0o640);
			const replayFd = fs.openSync(path.join(staging, 'replay.orarep'), fs.constants.O_RDONLY);
			try { fs.fsyncSync(replayFd); } finally { fs.closeSync(replayFd); }
		}
		const stagingFd = fs.openSync(staging, fs.constants.O_RDONLY);
		try { fs.fsyncSync(stagingFd); } finally { fs.closeSync(stagingFd); }
		// A .job name is the completeness marker. The verifier only scans these
		// names and atomically moves one into its inaccessible processing dir.
		fs.renameSync(staging, complete);
		const inboxFd = fs.openSync(rankedInbox, fs.constants.O_RDONLY);
		try { fs.fsyncSync(inboxFd); } finally { fs.closeSync(inboxFd); }
		return complete;
	} catch (error) {
		fs.rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}

// Mirror every log line into the status ring (the browser GUI reads it).
for (const level of ['log', 'error']) {
	const original = console[level].bind(console);
	console[level] = (...parts) => {
		const line = parts.map(p => (p && p.stack) ? p.message : String(p)).join(' ');
		statusLog.push(`[${level}] ${line}`);
		if (statusLog.length > 200) statusLog.shift();
		original(...parts);
	};
}
// T1.5: ONE counted player path for both byte paths (local mux socket and
// relay tunnel channel alike, §5.4). players drives the idle reaper, the
// status surfaces and the spine status message.
function attachPlayer(room) {
	if (!room) return;
	room.players += 1;
	room.lastActiveAt = Date.now();
}
function detachPlayer(room) {
	if (!room) return;
	room.players = Math.max(0, room.players - 1);
	if (room.players === 0) room.lastActiveAt = Date.now();
}

// ---- machine capacity sampler: real load, real memory, real RSS ----
// Every 5 s a sample lands in a 60-deep ring (5 min of history). The spine
// register/status messages and allocateRoom's degraded-slot enforcement both
// read computeCapacity(), so advertised slots always match measured reality.
const samples = []; // ring of last 60 {ts, load1, memFree, cores, dedicatedRssBytes}

function readRssBytes(pid) {
	// /proc/<pid>/statm field 2 = resident pages; page size 4096 on the Linux
	// VPS target. Other platforms (macOS dev) report 0 — capacity math still
	// works off loadavg/freemem there.
	try {
		const parts = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(' ');
		const residentPages = Number(parts[1]);
		return Number.isFinite(residentPages) ? residentPages * 4096 : 0;
	} catch { return 0; }
}

const samplerTimer = setInterval(() => {
	let rss = 0;
	for (const room of rooms.values()) {
		if (room.child?.pid) rss += readRssBytes(room.child.pid);
	}
	// macOS: os.freemem() is only the kernel free list and collapses under
	// file cache; process.availableMemory() (Node >= 22.14, uv_get_available_
	// memory) counts purgeable/inactive pages and matches the real headroom.
	const memFree = process.availableMemory?.() ?? os.freemem();
	samples.push({ ts: Date.now(), load1: os.loadavg()[0], memFree, cores: os.cpus().length, dedicatedRssBytes: rss });
	if (samples.length > 60) samples.shift();
}, 5_000);
samplerTimer.unref();

function computeCapacity() {
	const s = samples.length ? samples[samples.length - 1] : { load1: 0, memFree: os.totalmem(), cores: os.cpus().length, dedicatedRssBytes: 0 };
	const loadPct = s.load1 / s.cores;
	const healthy = loadPct < 0.9 && s.memFree > 512 * 1024 * 1024;
	const degraded = !healthy && loadPct < 1.2 && s.memFree > 256 * 1024 * 1024;
	return {
		freeMatches: Math.max(0, maxMatches - rooms.size),
		healthy,
		degraded,
		loadPct,
		dedicatedRssBytes: s.dedicatedRssBytes,
	};
}

// T1.7: prove a port is free on BOTH loopback stacks before handing it to a
// room — the node's own allocations are not the only listeners on the box.
function probePort(p) {
	return new Promise(resolve => {
		const v4 = net.createServer();
		const v6 = net.createServer();
		let done = false;
		const finish = ok => {
			if (done) return;
			done = true;
			try { v4.close(); } catch { /* not listening */ }
			try { v6.close(); } catch { /* not listening */ }
			resolve(ok);
		};
		v4.once('error', () => finish(false));
		v6.once('error', () => finish(false));
		v4.listen(p, '127.0.0.1', () => {
			v6.listen(p, '::1', () => finish(true));
		});
	});
}

async function allocateRoom(spec) {
	const { map, slots } = spec;
	if (draining) return null;
	if (rooms.size >= maxMatches) return null;
	// Unhealthy machines reject rooms; degraded machines only accept 1v1.
	const cap = computeCapacity();
	if (!cap.healthy && !cap.degraded) return null;
	if (cap.degraded && Number(slots ?? 2) > 2) return null;

	let port = null;
	for (let p = basePort; p < basePort + 100; p++) {
		if (ports.has(p)) continue;
		if (await probePort(p)) { port = p; break; }
	}
	if (port === null) return null;
	// Draining may have started while the async port probe was in flight.
	if (draining || rooms.size >= maxMatches) return null;

	const id = spec.roomId ?? crypto.randomBytes(8).toString('hex');
	if (!/^[0-9a-f]{16}$/.test(id) || rooms.has(id)) return null;
	// T1.1: the dedicated server starts DIRECTLY — no shell, no launcher
	// script, never a build. A missing artefact is `500 runner-missing` (§5.3).
	const runner = resolveRunner(engineRoot);
	const modSearchPaths = path.join(engineRoot, 'steelseed-host/generated/mods');
	// T1.2: per-room SupportDir under --data-dir; created here, deleted when
	// the room ends, so rooms never touch the player's OpenRA profile.
	const roomDir = path.join(dataDir, 'rooms', id);
	fs.mkdirSync(roomDir, { recursive: true });
	const args = buildArgs({
		name: spec.name,
		port,
		map,
		password: spec.password,
		solo: spec.solo,
		debugSync,
		ranked: spec.ranked === true,
	}, { engineRoot, supportDir: roomDir });
	const child = spawn(runner.cmd, [...runner.prefixArgs, ...args], {
		cwd: engineRoot,
		env: dedicatedServerEnv(process.env, modSearchPaths),
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
		windowsHide: true,
	});
	// T1.6: the pidfile lets the next node start reclaim an orphaned server.
	fs.writeFileSync(path.join(roomDir, 'server.pid'), `${child.pid}\n`);
	ports.add(port);
	const room = {
		id,
		port,
		map,
		slots,
		name: spec.name,
		// §5.5 rooms report: `locked` = the room is password-protected.
		password: spec.password,
		settings: spec.settings,
		hostKey: spec.hostKey ?? null,
		ranked: spec.ranked === true,
		roomClaim: spec.roomClaim ?? null,
		participantClaims: Array.isArray(spec.participantClaims) ? [...spec.participantClaims] : [],
		consumedClaims: new Set(),
		// Ranked claims are bound to the server-assigned OpenRA client index
		// observed in the first 8-byte handshake. No arrival-order inference.
		rankedBindings: new Map(),
		rankedBindingByClient: new Map(),
		rankedBindingError: null,
		// T3.5: only LAN-visible rooms ride the beacon.
		visibility: spec.visibility ?? 'lan',
		// T3.19: set for standing rooms — skips `reserved`, skips the reaper,
		// replaced protocol.standing.restartAfterEndSeconds after it ends.
		standingEntry: spec.standing ?? null,
		players: 0,
		// T1.4: booting ──TCP accept probe──▶ reserved ──first join──▶ lobby
		// ──started──▶ playing; any exit ──▶ ended. Single-use: the room never
		// becomes a fresh lobby.
		state: 'booting',
		reservedAt: null,
		// Idle bookkeeping: a room nobody is connected to must die — the engine
		// has no late-join, so an abandoned room is unclaimable and only lies
		// in the directory.
		lastActiveAt: Date.now(),
		child,
		createdAt: Date.now(),
	};
	if (room.ranked) {
		fs.writeFileSync(path.join(roomDir, 'ranked-claims.json'), `${JSON.stringify({
			schema: 1,
			roomClaim: spec.roomClaim ?? null,
			participantClaims: room.participantClaims,
		})}\n`, { mode: 0o600 });
	}
	rooms.set(id, room);
	// T2.5: a new room is a registry change — tell the relay at once.
	spineReportRooms();
	const retainRankedCustody = why => {
		// The node never verifies, signs or settles. It writes one complete replay
		// job into the verifier inbox, then loses access when the isolated worker
		// atomically claims it. Process exit and socket state are custody metadata,
		// never outcome authority.
		try {
			const decodeClaim = token => {
				try {
					const encoded = String(token).split('.')[0];
					return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
				} catch { return null; }
			};
			const roomClaimPayload = decodeClaim(room.roomClaim);
			const replayFiles = [];
			const visit = dir => {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) visit(full);
					else if (entry.isFile() && entry.name.endsWith('.orarep')) replayFiles.push(full);
				}
			};
			visit(roomDir);
			const custody = {
				schema: 1,
				roomId: id,
				matchId: roomClaimPayload?.matchId ?? null,
				roomNonce: roomClaimPayload?.nonce ?? null,
				simBuild: roomClaimPayload?.simBuild ?? null,
				endedAt: Date.now(),
				processReason: why,
				status: 'pending-verification',
				terminationPolicy: 'same-engine-replay-required',
				replayFiles: replayFiles.map(file => path.basename(file)),
				rankedBindings: [...room.rankedBindings.entries()].map(([claim, binding]) => ({
					claimDigest: crypto.createHash('sha256').update(claim).digest('hex'), ...binding,
				})),
				bindingError: room.rankedBindingError,
			};
			const claims = JSON.parse(fs.readFileSync(path.join(roomDir, 'ranked-claims.json'), 'utf8'));
			const roomClaim = decodeClaim(claims.roomClaim);
			const participants = (claims.participantClaims ?? []).map(token => {
				const claim = decodeClaim(token);
				const binding = claim && room.rankedBindings.get(token);
				const completeBinding = binding && Number.isInteger(binding.clientIndex) && Number.isInteger(binding.seat) && Number.isInteger(binding.team);
				return claim ? { userId: claim.userId, seat: claim.seat, team: claim.team, clientIndex: completeBinding ? binding.clientIndex : undefined } : null;
			}).filter(Boolean);
			enqueueRankedReplay({ replayFile: replayFiles[0] ?? null,
				claim: roomClaim ? { ...roomClaim, participants } : { participants }, custody });
		} catch (error) {
			console.error(`[roomhost] ranked custody failed for ${id}: ${error.message}`);
		}
	};
	const endRoom = why => {
		// Lifecycle policy can publish `ended` before the child has actually
		// exited. Registry membership, not the public state, is the idempotence
		// guard so that exit still releases the room slot and support directory.
		if (!rooms.has(id)) return;
		room.state = 'ended';
		rooms.delete(id);
		ports.delete(port);
		// T1.2+T1.6: SupportDir and pidfile are transient — gone when the room is.
		if (room.ranked) retainRankedCustody(why);
		fs.rmSync(roomDir, { recursive: true, force: true });
		// T3.19: a standing room's entry schedules its own replacement.
		if (room.standingEntry) standingEnded(room.standingEntry, room);
		console.log(`[roomhost] room ${id} ${why} (port ${port})`);
		// T2.5: the room left the registry — tell the relay at once.
		spineReportRooms();
		if (draining && rooms.size === 0) setImmediate(() => {
			if (draining && rooms.size === 0) shutdown(options.exitOnDrain ? protocol.nodeTunnel.drainedExitCode : 0);
		});
	};
	child.on('exit', () => endRoom('dedicated exited'));
	// A ChildProcess 'error' with no listener throws and kills the whole node.
	child.on('error', err => endRoom(`dedicated spawn error: ${err.message}`));
	// T1.3: drain both streams — an undrained pipe would stall the server —
	// into a 200-line ring, mirrored through the node logger with a room tag.
	room.log = [];
	// T3.19: the crash-guard log line quotes the dead instance's stderr tail.
	room.stderrTail = [];
	for (const stream of ['stdout', 'stderr']) {
		const tag = stream === 'stdout' ? 'out' : 'err';
		child[stream].setEncoding('utf8');
		child[stream].on('data', chunk => {
			for (const line of chunk.split('\n')) {
				if (!line) continue;
				room.log.push(`${tag} ${line}`);
				if (room.log.length > 200) room.log.shift();
				if (stream === 'stderr') {
					room.stderrTail.push(line);
					if (room.stderrTail.length > 8) room.stderrTail.shift();
				}
				console.log(`[room ${id.slice(0, 6)}] ${line}`);
				handleRoomLine(room, line);
			}
		});
	}
	return room;
}

// T1.4: state transitions from the drained server stdout (literal strings
// printed by OpenRA.Server — never parsed lobby or order bytes; the pump
// stays blind, §3 rule 3).
function setRoomState(room, state) {
	if (room.state === state) return;
	room.state = state;
	if (state === 'reserved') room.reservedAt = Date.now();
	console.log(`[room ${room.id.slice(0, 6)}] state ${state} (port ${room.port})`);
	// T2.5: every lifecycle transition is a registry change — report at once
	// (the relay binds roomId on the first report and lists lobby/playing).
	spineReportRooms();
}

function handleRoomLine(room, line) {
	if (line.includes('notification-joined') && room.state === 'reserved') setRoomState(room, 'lobby');
	else if (line.includes('notification-game-started') && room.state === 'lobby') setRoomState(room, 'playing');
	else if (line.includes('No one is playing, shutting down')) {
		// Single-use rooms: a finished match never becomes a fresh lobby.
		// `ended` is reserved for endRoom(): setting it here made the child's
		// later exit callback return before replay custody and room cleanup ran.
		// `ending` retracts the public row immediately while preserving the one
		// authoritative exit path that copies the finalized replay first.
		setRoomState(room, 'ending');
		// Do not terminate here: OpenRA still has to run Server.Shutdown(), which
		// disposes the replay recorder and appends mandatory metadata.  Killing on
		// this line retained a truncated .orarep that no same-engine verifier could
		// open.  The dedicated wrapper announces its next instance only after that
		// shutdown has completed; kill before the replacement starts listening.
	}
	else if (line.includes('Starting a new server instance') && room.state === 'ending')
		killTree(room.child);
}

// TCP accept probe: connect to 127.0.0.1:<port>, destroy at once. A success
// means the dedicated server's listen socket exists.
function probeTcp(port) {
	return new Promise(resolve => {
		const socket = net.connect({ host: '127.0.0.1', port });
		const done = ok => {
			socket.destroy();
			resolve(ok);
		};
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

// The spine report carries EVERY room with its state: the spine's player
// tunnel routes against the full registry (a reserved room must stay
// dialable right after create-ok, before anyone joined), while the public
// directory stays lobby/playing (§5.4) — the spine applies that filter.
function spineRoomReport() {
	return [...rooms.values()].map(room => ({ ...roomSummary(room), state: room.state }));
}

// Per-room lifecycle ticker: accept probe, placed-room creator claim TTL and
// the absolute lifetime of every relay-placed match (including playing).
const stateTimer = setInterval(() => {
	const now = Date.now();
	for (const room of [...rooms.values()]) {
		const expiry = roomLifecycleExpiry(room, now,
			protocol.timeouts.claimTtlSeconds * 1000,
			protocol.timeouts.placedMatchMaxLifetimeSeconds * 1000);
		if (expiry === 'max-lifetime') {
			console.log(`[roomhost] placed match ${room.id} reached its absolute ${protocol.timeouts.placedMatchMaxLifetimeSeconds}s lifetime — stopping dedicated (port ${room.port})`);
			setRoomState(room, 'ending');
			killTree(room.child);
		} else if (expiry === 'claim-ttl') {
			console.log(`[roomhost] placed room ${room.id} unclaimed for ${protocol.timeouts.claimTtlSeconds}s — stopping dedicated (port ${room.port})`);
			setRoomState(room, 'ending');
			killTree(room.child);
		} else if (room.state === 'booting') {
			probeTcp(room.port).then(ok => {
				if (ok && rooms.has(room.id) && room.state === 'booting') {
					// T3.19: a standing room has no creator — it skips
					// `reserved` (and the claim TTL) and opens as `lobby`
					// on the first successful accept probe.
					setRoomState(room, room.standingEntry ? 'lobby' : 'reserved');
				}
			});
		}
	}
}, 500);
stateTimer.unref();

// The mux's REAL port: --ws 0 lets the kernel pick, so summaries carry the
// bound port inside wsUrl, never the requested one (tests and the desktop
// shell rely on it).
let actualMuxPort = muxPort;
function roomWsUrl(roomId) {
	return `ws://127.0.0.1:${actualMuxPort}/g/${roomId}`;
}
// §5.3 room shape: identity, listing metadata and the authoritative local
// endpoint. The dedicated server's raw TCP port is an implementation detail
// behind the ws mux — it never leaves the node (T2.8 retired it).
function roomSummary(room) {
	return {
		roomId: room.id,
		name: room.name ?? `Room-${room.id.slice(0, 6)}`,
		map: room.map,
		slots: room.slots,
		players: room.players,
		createdAt: room.createdAt,
		// Host-chosen room ambience (tod/weather/gamespeed/...). Pass-through:
		// the spine forwards summaries verbatim, so joiners inherit at start.
		settings: room.settings ?? {},
	};
}
// §5.3 room shape for the /v2 API: the authoritative local endpoint and the
// lifecycle state ride along (all states listed, including booting/reserved).
function roomSummaryV2(room) {
	return { ...roomSummary(room), wsUrl: roomWsUrl(room.id), state: room.state };
}

// ---- token bucket for POST /rooms (T1.9: every caller; 3 tokens, one per
// 30 s). Every caller is loopback, so the bucket is keyed on the caller
// identity, never on the remote address alone. ----
const buckets = new Map();

// Length-safe, timing-safe node-key comparison (§5.3).
function keyMatches(provided) {
	if (typeof provided !== 'string' || provided.length === 0) return false;
	const a = crypto.createHash('sha256').update(provided).digest();
	const b = crypto.createHash('sha256').update(nodeKey).digest();
	return crypto.timingSafeEqual(a, b);
}

// T1.10/§5.3: create validation, in this exact order, first failure wins
// with 400 {"error":"invalid","field":…}. Request fields are `name` and
// `solo`; today's settings.roomName / settings.mod /
// settings.enableSingleplayer are unknown fields and are ignored.
function validateCreate(body, { keyed }) {
	const fail = field => ({ error: 'invalid', field });
	if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('map');
	const map = body.map;
	if (typeof map !== 'string' || !/^[0-9a-f]{40}$/.test(map) || !catalogByUid.has(map)) return fail('map');
	const entry = catalogByUid.get(map);
	const slots = body.slots;
	// §5.3: slots in 2…5. The 2…8 owner-tier ceiling lands with owner tier
	// registration (Phase 6, protocol.nodeApi.slotsMaxOwnerTier) — until then
	// every caller gets the community ceiling.
	const slotCeiling = protocol.nodeApi.slotsMax;
	if (!Number.isInteger(slots) || slots < protocol.nodeApi.slotsMin || slots > slotCeiling || slots > (entry.players ?? slotCeiling)) return fail('slots');
	let name = typeof body.name === 'string' ? body.name.normalize('NFC').trim() : null;
	if (name !== null && (name.length < 1 || name.length > 32)) return fail('name');
	if (name === null) {
		// §5.3 governs the keyed local API: there, name is required. Relay
		// tunnel creates (§5.5, keyed=false) predate the name field — they
		// get a placeholder until the relay forwards names (T1.26+).
		if (keyed) return fail('name');
		name = 'Room';
	}
	const password = body.password ?? '';
	if (typeof password !== 'string' || password.length > 32 || !/^[\x20-\x7E]*$/.test(password)) return fail('password');
	const visibility = body.visibility ?? 'lan';
	if (visibility !== 'lan' && visibility !== 'public') return fail('visibility');
	const solo = body.solo ?? false;
	if (typeof solo !== 'boolean') return fail('solo');
	const settings = body.settings ?? {};
	const hostKey = body.hostKey ?? null;
	if (hostKey !== null && (typeof hostKey !== 'string' || !/^[0-9a-f]{32}$/.test(hostKey))) return fail('hostKey');
	const roomId = body.roomId ?? null;
	if (roomId !== null && (typeof roomId !== 'string' || !/^[0-9a-f]{16}$/.test(roomId))) return fail('roomId');
	const ranked = body.ranked === true;
	// Ranked rooms are relay-admitted owner matches. A local keyed API caller
	// cannot mint one, even when this node happens to be connected to a spine.
	if (ranked && (keyed || !spineUrl || !spineToken)) return fail('ranked');
	const participantClaims = body.participantClaims ?? [];
	if (!Array.isArray(participantClaims) || participantClaims.some(claim => typeof claim !== 'string' || claim.length > 4096)) return fail('participantClaims');
	if (ranked && (typeof body.roomClaim !== 'string' || participantClaims.length < 2)) return fail('ranked');
	const gamespeed = settings.gamespeed ?? 'default';
	if (!catalogSpeeds.has(gamespeed)) return fail('settings.gamespeed');
	const tod = settings.tod ?? 'auto';
	if (!['auto', 'day', 'night'].includes(tod)) return fail('settings.tod');
	const weather = settings.weather ?? 'on';
	if (!['on', 'off'].includes(weather)) return fail('settings.weather');
	// solo is honoured only together with a valid node key (§5.3): requests
	// through the relay tunnel arrive unkeyed and always get False.
	return {
		map,
		slots,
		name,
		password,
		visibility,
		solo: solo && keyed,
		settings: { gamespeed, tod, weather },
		roomId,
		hostKey,
		ranked,
		roomClaim: typeof body.roomClaim === 'string' ? body.roomClaim : null,
		participantClaims,
	};
}
// T3.19: --rooms-file (§5.4 "Standing rooms"). Every entry is validated
// exactly like a POST /v2/rooms body; `maps` holds 1…16 catalog uids that
// successive instances take round-robin. At most --max-matches entries —
// the community tier's cap. Any failure refuses to start the node.
function loadStandingRooms(file, maxEntries) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		throw new Error(`roomhost: --rooms-file ${file} is not readable JSON: ${err.message}`);
	}
	if (parsed?.schema !== 1 || !Array.isArray(parsed.rooms))
		throw new Error(`roomhost: --rooms-file ${file} must be {"schema":1,"rooms":[…]}`);
	if (parsed.rooms.length > maxEntries)
		throw new Error(`roomhost: --rooms-file ${file} has ${parsed.rooms.length} entries — --max-matches allows ${maxEntries}`);
	return parsed.rooms.map(raw => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			throw new Error(`roomhost: --rooms-file ${file}: every entry must be an object`);
		const label = `standing room "${String(raw.name ?? '?').slice(0, 32)}"`;
		const maps = raw.maps;
		if (!Array.isArray(maps) || maps.length < 1 || maps.length > protocol.standing.mapsPerEntryMax)
			throw new Error(`roomhost: ${label}: maps must hold 1…${protocol.standing.mapsPerEntryMax} catalog uids`);
		for (const uid of maps) {
			if (typeof uid !== 'string' || !/^[0-9a-f]{40}$/.test(uid) || !catalogByUid.has(uid))
				throw new Error(`roomhost: ${label}: map ${String(uid).slice(0, 12)}… is not in the catalog`);
		}
		// Exactly the POST /v2/rooms validation, keyed like the local API.
		const spec = validateCreate({
			map: maps[0],
			slots: raw.slots,
			name: raw.name,
			password: raw.password,
			solo: false,
			settings: raw.settings,
			visibility: 'public',
		}, { keyed: true });
		if (spec.error)
			throw new Error(`roomhost: ${label}: invalid ${spec.field}`);
		return {
			name: spec.name,
			slots: spec.slots,
			password: spec.password,
			settings: spec.settings,
			maps,
			cursor: 0,
			disabled: false,
			fastDeaths: 0,
		};
	});
}

// T3.19: 5 consecutive instances of one entry that end within 60 s of
// `booting` disable the entry, logged with the dead instance's stderr tail.
// Any instance that survives the fast-death window resets the count.
function standingEnded(entry, room) {
	if (draining || entry.disabled) return;
	const fast = !room || Date.now() - room.createdAt <= protocol.standing.fastDeathWindowSeconds * 1000;
	entry.fastDeaths = fast ? entry.fastDeaths + 1 : 0;
	if (entry.fastDeaths >= protocol.standing.fastDeathLimit) {
		entry.disabled = true;
		console.log(`standing room "${entry.name}" disabled: ${(room?.stderrTail ?? []).slice(-5).join(' | ')}`);
		return;
	}
	const restart = setTimeout(() => bootStandingRoom(entry), protocol.standing.restartAfterEndSeconds * 1000);
	restart.unref();
}

// Create the next instance of a standing entry through the SAME code path
// as POST /v2/rooms — loadStandingRooms already ran validateCreate, this
// calls allocateRoom (same spawn, same guards). No capacity: retry on the
// replacement cadence.
function bootStandingRoom(entry) {
	if (draining || entry.disabled) return;
	const uid = entry.maps[entry.cursor % entry.maps.length];
	entry.cursor += 1;
	allocateRoom({
		name: entry.name,
		slots: entry.slots,
		password: entry.password,
		settings: entry.settings,
		visibility: 'public',
		solo: false,
		map: uid,
		standing: entry,
	}).then(room => {
		if (room) return;
		console.log(`[roomhost] standing room "${entry.name}": no capacity — retrying in ${protocol.standing.restartAfterEndSeconds}s`);
		const retry = setTimeout(() => bootStandingRoom(entry), protocol.standing.restartAfterEndSeconds * 1000);
		retry.unref();
	}).catch(err => {
		// A boot failure counts as a fast death (RunnerMissing and friends).
		console.log(`[roomhost] standing room "${entry.name}": boot failed: ${err.message}`);
		standingEnded(entry, null);
	});
}

function originIsLoopback(origin) {
	if (typeof origin !== 'string') return false;
	try {
		const u = new URL(origin);
		return (u.protocol === 'http:' || u.protocol === 'https:')
			&& (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1');
	} catch {
		return false;
	}
}
function allowCreate(callerId) {
	const now = Date.now();
	const bucket = buckets.get(callerId) ?? { tokens: 3, last: now };
	bucket.tokens = Math.min(3, bucket.tokens + (now - bucket.last) / 30_000);
	bucket.last = now;
	if (bucket.tokens < 1) {
		buckets.set(callerId, bucket);
		return false;
	}
	bucket.tokens -= 1;
	buckets.set(callerId, bucket);
	return true;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		req.on('data', c => {
			if (settled) return;
			size += c.length;
			if (size > 16 * 1024) {
				settled = true;
				chunks.length = 0;
				const error = new Error('body too large');
				error.code = 'ERR_BODY_TOO_LARGE';
				reject(error);
			}
			else chunks.push(c);
		});
		req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString()); } });
		req.on('error', error => { if (!settled) { settled = true; reject(error); } });
	});
}

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.m4a': 'audio/mp4',
	'.mp3': 'audio/mpeg',
	'.ogg': 'audio/ogg',
	'.wav': 'audio/wav',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.ttf': 'font/ttf',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.bin': 'application/octet-stream',
	'.dat': 'application/octet-stream',
	'.yaml': 'text/yaml',
	'.lua': 'text/plain',
	'.frag': 'text/plain',
	'.vert': 'text/plain',
	'.map': 'application/json',
};

function serveStatic(pathname, res) {
	let rel;
	try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); }
	catch {
		res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('bad request');
		return;
	}
	const target = path.normalize(path.join(bundleRoot, rel === '' ? 'index.html' : rel));
	// T1.9: the separator beats the /bundle-prefix sibling-directory bypass.
	if (!target.startsWith(bundleRoot + path.sep)) {
		res.writeHead(403);
		res.end('forbidden');
		return;
	}
	fs.stat(target, (err, st) => {
		const file = !err && st.isDirectory() ? path.join(target, 'index.html') : target;
		if (err || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
			res.writeHead(404);
			res.end('not found');
			return;
		}
		res.writeHead(200, {
			'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
			'content-length': fs.statSync(file).size,
			'cache-control': 'no-cache',
		});
		fs.createReadStream(file).pipe(res);
	});
}

// T1.9: the local API's front door (§5.3). Order matters: Host first, then
// CORS preflight, then the mutating-request guards. Every response to a
// loopback Origin carries CORS headers so the desktop pages (different
// loopback port) can call the API.
const httpServer = http.createServer(async (req, res) => {
	const apiPort = httpServer.address() ? httpServer.address().port : httpPort;
	const host = req.headers.host ?? '';
	if (host !== `127.0.0.1:${apiPort}` && host !== `localhost:${apiPort}`) {
		res.writeHead(421);
		res.end('misdirected request');
		return;
	}
	const origin = req.headers.origin;
	const corsHeaders = originIsLoopback(origin)
		? {
			'access-control-allow-origin': origin,
			'access-control-allow-methods': 'GET, POST, DELETE',
			'access-control-allow-headers': 'content-type, x-redline-node-key',
		}
		: {};
	if (req.method === 'OPTIONS') {
		res.writeHead(204, corsHeaders);
		res.end();
		return;
	}
	const sendJson = (code, body) => {
		res.writeHead(code, { 'content-type': 'application/json', ...corsHeaders });
		res.end(JSON.stringify(body));
	};
	if ((req.method === 'POST' || req.method === 'DELETE')) {
		const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
		if (contentType !== 'application/json') {
			sendJson(415, { error: 'unsupported media type' });
			return;
		}
		if (!keyMatches(req.headers['x-redline-node-key'])) {
			sendJson(403, { error: 'invalid node key' });
			return;
		}
		if (origin !== undefined && !originIsLoopback(origin)) {
			sendJson(403, { error: 'cross-origin request refused' });
			return;
		}
	}
	const url = new URL(req.url, `http://127.0.0.1:${apiPort}`);

// T2.2: the one create/kill implementation behind the /v2 contract (§5.3).
const createRoom = async () => {
		if (draining) {
			sendJson(503, { error: 'draining' });
			return;
		}
		// §5.4: a standing node creates its own rooms from --rooms-file
		// (T3.19); the API refuses creates with the reserved error string.
		if (mode === 'standing') {
			sendJson(403, { error: protocol.nodeApi.standingErrorCode });
			return;
		}
		if (!allowCreate(req.headers['x-redline-node-key'])) {
			sendJson(429, { error: 'try later' });
			return;
		}
		let body;
		try {
			body = JSON.parse((await readBody(req)) || '{}');
		} catch (error) {
			sendJson(error?.code === 'ERR_BODY_TOO_LARGE' ? 413 : 400,
				{ error: error?.code === 'ERR_BODY_TOO_LARGE' ? 'body too large' : 'invalid json' });
			return;
		}
		const spec = validateCreate(body, { keyed: true });
		if (spec.error) {
			console.log(`[roomhost] create rejected: invalid ${spec.field}`);
			sendJson(400, spec);
			return;
		}
		let room;
		try {
			room = await allocateRoom(spec);
		} catch (err) {
			if (err instanceof RunnerMissing) {
				console.log(`[roomhost] create rejected: ${err.message}`);
				sendJson(500, { error: 'runner-missing', detail: err.detail });
				return;
			}
			throw err;
		}
		if (room === null) {
			const cap = computeCapacity();
			console.log(`[roomhost] create rejected (rooms=${rooms.size} loadPct=${cap.loadPct.toFixed(2)} healthy=${cap.healthy} degraded=${cap.degraded})`);
			sendJson(503, { error: 'no-capacity' });
			return;
		}
		console.log(`[roomhost] room ${room.id} created (map ${room.map}, port ${room.port})`);
		// §5.3/T2.4: 201 answers IMMEDIATELY with state "booting" — the T1.4
		// state machine drives booting → reserved in the background; nobody
		// blocks on the dedicated server.
		sendJson(201, { room: roomSummaryV2(room) });
	};
	const deleteRoom = roomId => {
		// T3.19: standing rooms belong to the node — clients may not delete.
		if (mode === 'standing') {
			sendJson(403, { error: protocol.nodeApi.standingErrorCode });
			return;
		}
		const room = rooms.get(roomId);
		if (!room) {
			sendJson(404, { error: 'not found' });
			return;
		}
		killTree(room.child);
		res.writeHead(204, corsHeaders);
		res.end();
	};

	if (url.pathname === '/v2/health' && req.method === 'GET') {
		const capacity = computeCapacity();
		sendJson(200, {
			schema: protocol.nodeApi.schema,
			// T3.5: the shell passes this to the LAN listener as --self.
			nodeId: nodeId(),
			build: buildInfo?.simBuild ?? 'unknown',
			rulesHash: process.env.REDLINE_RANKED_RULES_HASH ?? '',
			visibility: mode === 'donate' ? 'donate' : spineUrl ? 'public' : 'lan',
			relay: {
				url: spineUrl,
				connected: !!spineWs && spineWs.readyState === WebSocket.OPEN,
				closeCode: lastSpineCloseCode,
			},
			rooms: rooms.size,
			players: [...rooms.values()].reduce((a, room) => a + room.players, 0),
			draining,
			freeMatches: draining ? 0 : capacity.freeMatches,
		});
		return;
	}
	if (url.pathname === '/v2/drain' && req.method === 'POST') {
		draining = true;
		const players = [...rooms.values()].reduce((a, room) => a + room.players, 0);
		sendJson(200, { schema: protocol.nodeApi.schema, draining: true, rooms: rooms.size, players, freeMatches: 0 });
		// Standing lobbies are intentionally exempt from the idle reaper. During
		// drain they have no players to protect, so close them; active matches
		// finish naturally before the node exits.
		for (const room of rooms.values()) {
			if (room.standingEntry && room.players === 0 && (room.state === 'booting' || room.state === 'lobby'))
				killTree(room.child);
		}
		if (rooms.size === 0) setImmediate(() => {
			if (draining && rooms.size === 0) shutdown(options.exitOnDrain ? protocol.nodeTunnel.drainedExitCode : 0);
		});
		return;
	}
	if (url.pathname === '/v2/rooms' && req.method === 'GET') {
		// §5.3: ALL states, including booting and reserved — the creator's UI
		// polls this (T2.4) until its room turns reserved.
		sendJson(200, { schema: protocol.nodeApi.schema, rooms: [...rooms.values()].map(roomSummaryV2) });
		return;
	}
	if (url.pathname === '/v2/rooms' && req.method === 'POST') {
		await createRoom();
		return;
	}
	const v2Delete = /^\/v2\/rooms\/([0-9a-f]{16})$/.exec(url.pathname);
	if (v2Delete && req.method === 'DELETE') {
		deleteRoom(v2Delete[1]);
		return;
	}
	if (url.pathname === '/status.json' && req.method === 'GET') {
		res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
		res.end(JSON.stringify({
			uptimeMs: Date.now() - startedAt,
			spine: spineUrl ? { url: spineUrl, connected: spineWs && spineWs.readyState === WebSocket.OPEN } : null,
			geo: '',
			rooms: [...rooms.values()].map(r => ({
				roomId: r.id,
				name: r.name,
				map: r.map,
				// Loopback diagnostics: the dedicated's raw TCP port is node-
				// internal and only ever shown here, never in the /v2 API.
				port: r.port,
				players: r.players,
				dedicatedAlive: r.child.exitCode === null && r.child.signalCode === null,
				// T1.3: the room's own stdout/stderr tail.
				log: (r.log ?? []).slice(-50),
			})),
			channels: tunnelChannels.size,
			log: statusLog.slice(-100),
		}));
		return;
	}
	if (url.pathname === '/status' && req.method === 'GET') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(STATUS_HTML);
		return;
	}
	if (req.method === 'GET' && httpPort !== 0) {
		serveStatic(url.pathname, res);
		return;
	}

	res.writeHead(404, { 'content-type': 'text/plain' });
	res.end('not found');
});

// ---- WebSocket mux: /g/<roomId> pumps to the room's dedicated port ----
// noServer: the upgrade is handled explicitly, on the mux's own HTTP server,
// so room lookup and origin checks run BEFORE the handshake completes.
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

const wsServer = http.createServer((req, res) => {
	res.writeHead(426, { 'content-type': 'text/plain' });
	res.end('websocket upgrade required');
});

const muxPeerSockets = new Map();
function muxPeerKey(req) {
	const address = req.socket.remoteAddress ?? '?';
	return address.startsWith('::ffff:') ? address.slice(7) : address;
}

wsServer.on('upgrade', (req, socket, head) => {
	console.log(`[roomhost] upgrade ${req.url} rooms=${rooms.size} origin=${req.headers.origin ?? '-'}`);
	const url = new URL(req.url, 'http://127.0.0.1');
	// Native clients send no Origin; the Electron/shared AppBundle uses a
	// loopback Origin. A foreign web page must not drive a LAN/loopback mux as
	// a cross-site WebSocket even if it learns a room id.
	if (req.headers.origin !== undefined && !originIsLoopback(req.headers.origin)) {
		wss.handleUpgrade(req, socket, head, ws => closeRelayWs(ws, 4403, protocol.playerCloseCodes['4403'].reason));
		return;
	}
	// T1.9: the path contract is exact — /g/<16 hex>. JoinMultiplayer dials
	// with SetWsEndpoint(<room.wsUrl>); bare host:port dials are refused (T2.8
	// retired the single-room fallback).
	let room = null;
	const match = /^\/g\/([0-9a-f]{16})$/.exec(url.pathname);
	if (match) room = rooms.get(match[1]) ?? null;
	if (!room) {
		socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
		socket.destroy();
		return;
	}
	// A release drain keeps existing channels alive but must freeze joins to
	// standing lobbies, otherwise a match can start after the installer has
	// observed zero players and just before it stops the node.
	if (draining) {
		socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
		socket.destroy();
		return;
	}
	// Placed rooms are creator-claimed while booting/reserved. Ranked rooms are only
	// reachable through the relay, which supplies the one-time participant
	// claim on its control message; a direct LAN socket must never bypass it.
	if (room.ranked || (room.hostKey && ['booting', 'reserved'].includes(room.state) && url.searchParams.get('k') !== room.hostKey)) {
		socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
		socket.destroy();
		return;
	}
	const peerKey = muxPeerKey(req);
	if ((muxPeerSockets.get(peerKey) ?? 0) >= protocol.limits.maxPlayerSocketsPerIp) {
		wss.handleUpgrade(req, socket, head, ws => closeRelayWs(ws, 4429, protocol.playerCloseCodes['4429'].reason));
		return;
	}
	wss.handleUpgrade(req, socket, head, ws => {
		muxPeerSockets.set(peerKey, (muxPeerSockets.get(peerKey) ?? 0) + 1);
		ws.once('close', () => {
			const remaining = (muxPeerSockets.get(peerKey) ?? 1) - 1;
			if (remaining > 0) muxPeerSockets.set(peerKey, remaining);
			else muxPeerSockets.delete(peerKey);
		});
		const id = ++connId;
		attachPlayer(room);
		console.log(`[roomhost] ws #${id} -> room ${room.id} (port ${room.port}, players ${room.players})`);
		ws.on('close', () => detachPlayer(room));
		pump(ws, room.port, id);
	});
	});

let connId = 0;

function pump(ws, targetPort, id, onClosed) {
	let tcp = null;
	let tcpReady = false;
	let closed = false;
	let retryTimer = null;
	// A dead room must not buffer client bytes forever: cap the backlog and put
	// a hard deadline on the "dedicated still booting" retry loop (H1).
	const deadline = Date.now() + 30_000;
	const writer = createTcpWriter({
		limitBytes: RELAY_LIMITS.tcp,
		onFailure: why => {
			console.log(`[roomhost] #${id} ${why}`);
			closeBoth(why.message, why.code === 'ERR_RELAY_BACKPRESSURE');
		},
	});
	const wsWriter = createWsWriter(ws, {
		limitBytes: RELAY_LIMITS.ws,
		onFailure: why => {
			console.log(`[roomhost] #${id} ${why}`);
			closeBoth(why.message, why.code === 'ERR_RELAY_BACKPRESSURE');
		},
	});

	// A room's dedicated server takes seconds to boot; the first client can
	// arrive before the listen socket exists. Retry ECONNREFUSED until the
	// room dies, the client leaves, or the deadline passes; client bytes
	// buffer in the bounded tcp writer under the cap.
	function attempt() {
		console.log(`[roomhost] #${id} attempting connect to 127.0.0.1:${targetPort}`);
		if (closed) return;
		retryTimer = null;
		tcp = net.connect({ host: '127.0.0.1', port: targetPort });
		tcp.setNoDelay(true);
		tcp.on('connect', () => {
			tcpReady = true;
			writer.attach(tcp);
			console.log(`[roomhost] #${id} connected to 127.0.0.1:${targetPort}`);
		});
		tcp.on('data', chunk => {
			wsWriter.send(chunk, { binary: true });
		});
		tcp.on('error', err => {
			if (err.code === 'ECONNREFUSED' && !tcpReady && !closed) {
				if (Date.now() > deadline) return closeBoth('dedicated never came up');
				retryTimer = setTimeout(attempt, 1000);
				return;
			}
			closeBoth(`tcp error: ${err.message}`);
		});
		tcp.on('close', () => {
			if (!tcpReady && !closed && retryTimer !== null) return; // mid-retry teardown
			if (!closed) closeBoth('tcp closed');
		});
	}

	ws.on('message', (data, isBinary) => {
		const chunk = data instanceof Buffer ? data : Buffer.from(data);
		writer.write(chunk);
	});

	function closeBoth(why, overloaded = false) {
		if (closed) return;
		closed = true;
		clearTimeout(retryTimer);
		console.log(`[roomhost] #${id} ${why}`);
		writer.close();
		wsWriter.close();
		try { tcp.destroy(); } catch { /* already gone */ }
		closeRelayWs(ws, overloaded ? 1013 : 1011, overloaded ? 'relay backpressure' : 'relay closed');
	}
	ws.on('close', () => closeBoth('ws closed'));
	ws.on('close', () => { if (onClosed) onClosed(); });
	ws.on('error', err => closeBoth(`ws error: ${err.message}`));

	attempt();
}
// ---- idle room reaper ----
// The engine has no late-join: once a match starts the lobby socket closes, so
// a room whose last player left (or whose creator closed the browser) can never
// be reclaimed. Keeping it in the directory only lies to the next visitor. Kill
// the whole dedicated process group after `--idle-kill` seconds (default 120).
const reaperTimer = setInterval(() => {
	const now = Date.now();
	for (const room of rooms.values()) {
		// T1.5: the reaper only judges rooms a player could still claim.
		if (!['booting', 'reserved', 'lobby'].includes(room.state)) continue;
		// T3.19: a standing room in `lobby` is a community server's empty
		// state — it stays open for the next players and is never reaped.
		if (room.standingEntry && room.state === 'lobby') continue;
		// `lastActiveAt` marks when the room most recently became empty. A
		// connected host may spend longer than the idle window configuring the
		// lobby; that is active ownership, not an abandoned server.
		if (room.players !== 0) continue;
		if (now - room.lastActiveAt < idleKillMs) continue;
		console.log(`[roomhost] room ${room.id} idle > ${idleKillMs / 1000}s with 0 players — stopping dedicated (port ${room.port})`);
		killTree(room.child);
	}
}, 15_000);
reaperTimer.unref();

function shutdown(exitCode = 0) {
	console.log('\n[roomhost] shutting down, killing room dedicated servers...');
	// T1.6: kill every room's whole process tree, then exit.
	for (const room of rooms.values()) killTree(room.child);
	process.exit(exitCode);
}
// win32: a closed stdin is the close signal for a service-style node.
if (process.platform === 'win32') {
	process.stdin.on('end', () => {
		console.log('[roomhost] stdin closed');
		shutdown();
	});
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(sig, () => {
		console.log(`[roomhost] received ${sig}`);
		shutdown();
	});
}

await new Promise((resolve, reject) => {
	wsServer.once('error', reject);
	wsServer.listen(muxPort, muxHost, resolve);
});
console.log(`[roomhost] ws mux ws://${muxHost}:${wsServer.address().port}/g/<roomId> (max ${maxMatches} matches, lan=${options.lan ? 'yes' : 'no'})`);
actualMuxPort = wsServer.address().port;
await new Promise((resolve, reject) => {
	httpServer.once('error', reject);
	httpServer.listen(httpPort === 0 ? 0 : httpPort, apiHost, resolve);
});
console.log(`[roomhost] directory http://${apiHost}:${httpServer.address().port}/v2/rooms`);
console.log(`[roomhost] static root: ${bundleRoot}`);
// T3.19: the node creates its standing rooms itself — no client asked for
// them. Entries were validated against the catalog above.
for (const entry of standingEntries) bootStandingRoom(entry);
// T3.5: --lan starts the LAN announcer. Only LAN-visible rooms in
// lobby/playing are announced, and `ws` is the mux's REAL bound port — the
// listener builds ws://<source>:<ws>/g/<roomId> from the packet source.
if (options.lan) {
	startAnnouncer({
		getState: () => ({
			build: buildInfo?.simBuild ?? 'unknown',
			nodeId: nodeId(),
			name: nodeName,
			ws: actualMuxPort,
			rooms: [...rooms.values()]
				.filter(room => (room.state === 'lobby' || room.state === 'playing') && (room.visibility ?? 'lan') === 'lan')
				.map(room => ({
					id: room.id,
					name: room.name ?? `Room-${room.id.slice(0, 6)}`,
					map: catalogByUid.get(room.map)?.title ?? room.map,
					slots: room.slots,
					players: room.players,
					state: room.state,
					locked: !!room.password,
				})),
		}),
	});
	console.log(`[roomhost] LAN beacon announcing on ${GROUP}:${PORT} as node ${nodeId()}`);
}

// ---- federation: dial out to a spine so this node joins the network ----
// With --spine the node registers itself at the central relay and serves
// rooms for players that connect through the spine. Control messages are
// JSON text; player channel data is binary frames [u16 BE chanId][payload].
// chanId -> { roomId, writer, write, destroy }; the shared spine tunnel writer
// carries both JSON controls and framed player data.
const tunnelChannels = new Map();
let spineWs = null;
let tunnelWriter = null;
// T2.5 protocol 2: registration identity and reconnect bookkeeping.
let spineNodeId = null;
let reconnectDelayMs = protocol.reconnect.initialMs;
let lastSpineCloseCode = null;
// Tunnel rotation: Caddy force-closes proxied streams stream_close_delay (12 h)
// after any config reload, killing every match on a tunnel that predates it.
// An idle node therefore moves to a fresh tunnel after tunnelRotateMs. The
// successor registers with the same key first (the relay replaces the old
// tunnel with 4002 and keeps its rooms), and admissions stay frozen for that
// short handover. REDLINE_TUNNEL_ROTATE_MS exists for tests.
const tunnelRotateMs = Number(process.env.REDLINE_TUNNEL_ROTATE_MS) > 0 ? Number(process.env.REDLINE_TUNNEL_ROTATE_MS) : 8 * 60 * 60 * 1000;
let tunnelRegisteredAt = 0;
let rotation = null; // { ws, timer, activeClosed } while a successor tunnel registers
let inFlightCreates = 0;
let updateRequired = false; // a 4003 retired this build: no reconnect, no rotation

// T2.5/§5.5 4003: the build is not accepted. Emitted once, from whichever tunnel
// (current, successor or both) hears it first: stop retrying and print exactly
// the line the desktop shell and --exit-on-update-required listen for.
function onUpdateRequired(reasonText) {
	if (updateRequired) return;
	updateRequired = true;
	if (rotation) {
		clearTimeout(rotation.timer);
		try { rotation.ws?.terminate(); } catch { /* already gone */ }
		rotation = null;
	}
	// A successor can be refused before the relay closes the old connection.
	// Retire that still-current tunnel too; a stale build must not keep placing
	// public rooms through it while the replacement has been rejected.
	if (spineWs?.readyState === WebSocket.OPEN)
		closeRelayWs(spineWs, 4003, 'update required');
	const accepted = reasonText.split(',').map(s => s.trim()).filter(Boolean);
	console.log('[[redline-node]] ' + JSON.stringify({ event: 'update-required', accepted }));
	if (options.exitOnUpdateRequired) {
		console.log(`[roomhost] --exit-on-update-required: exiting with code ${protocol.nodeTunnel.updateRequiredExitCode}`);
		for (const room of rooms.values()) killTree(room.child);
		setTimeout(() => process.exit(protocol.nodeTunnel.updateRequiredExitCode), 1000);
	}
}

function spineSendJson(obj) {
	if (tunnelWriter) tunnelWriter.send(JSON.stringify(obj));
}

function spineReportRooms() {
	if (!spineWs || spineWs.readyState !== WebSocket.OPEN) return;
	// T2.5/§5.5 registry report: EVERY room with its state — the relay binds
	// each roomId to the first reporting node and filters its public
	// directory to lobby/playing (§5.4).
	spineSendJson({
		t: 'rooms',
		rooms: [...rooms.values()].map(room => ({
			...roomSummary(room),
			hostName: nodeName,
			mapUid: room.map,
			mapTitle: catalogByUid.get(room.map)?.title ?? '',
			state: room.state,
			locked: !!room.password,
		})),
	});
}

function spineOpenChannel(chanId, roomId, access = {}) {
	// §5.5: an open for an id this node still holds is answered with close —
	// a duplicate must never replace a live channel.
	if (tunnelChannels.has(chanId)) {
		spineSendJson({ t: 'close', chanId });
		return;
	}
	const room = rooms.get(roomId);
	if (!room) {
		spineSendJson({ t: 'close', chanId });
		return;
	}
	if (!room.ranked && room.state === 'reserved' && room.hostKey && access.hostKey !== room.hostKey) {
		spineSendJson({ t: 'close', chanId });
		return;
	}
	if (room.ranked) {
		if (!access.claim || !room.participantClaims.includes(access.claim) || room.consumedClaims.has(access.claim)) {
			spineSendJson({ t: 'close', chanId });
			return;
		}
		room.consumedClaims.add(access.claim);
	}
	let tcp = null;
	let tcpReady = false;
	let closed = false;
	let retryTimer = null;
	// Same contract as pump(): bounded backlog, bounded boot wait (H1).
	const deadline = Date.now() + 30_000;
	const writer = createTcpWriter({
		limitBytes: RELAY_LIMITS.tcp,
		onFailure: why => {
			console.log(`[roomhost] #${chanId} ${why}`);
			spineCloseChannel(chanId);
		},
	});
	function attempt() {
		if (closed) return;
		retryTimer = null;
		tcp = net.connect({ host: '127.0.0.1', port: room.port });
		tcp.setNoDelay(true);
		tcp.on('connect', () => {
			tcpReady = true;
			writer.attach(tcp);
		});
		tcp.on('data', chunk => {
			if (closed || !tunnelWriter) return;
			const bindingErrorBefore = room.rankedBindingError;
			rankedObserveServerBytes(room, channel, chunk, () => spineCloseChannel(chanId));
			if (!bindingErrorBefore && room.rankedBindingError)
				console.error(`[room ${room.id.slice(0, 6)}] ranked binding rejected channel ${chanId}: ${room.rankedBindingError}`);
			const frame = Buffer.allocUnsafe(2 + chunk.length);
			frame.writeUInt16BE(chanId, 0);
			chunk.copy(frame, 2);
			tunnelWriter.send(frame, { binary: true });
		});
		tcp.on('error', err => {
			if (err.code === 'ECONNREFUSED' && !tcpReady && !closed) {
				if (Date.now() > deadline) return spineCloseChannel(chanId);
				retryTimer = setTimeout(attempt, 1000);
				return;
			}
			spineCloseChannel(chanId);
		});
		tcp.on('close', () => {
			if (!tcpReady && !closed && retryTimer !== null) return; // mid-retry teardown
			if (!closed) spineCloseChannel(chanId);
		});
	}
	const channel = {
		roomId,
		chanId,
		claim: access.claim ?? null,
		observeBuffer: Buffer.alloc(0),
		clientIndex: undefined,
		writer,
		write: chunk => writer.write(chunk),
		destroy: () => {
			closed = true;
			clearTimeout(retryTimer);
			writer.close();
			try { tcp.destroy(); } catch { /* already gone */ }
		},
	};
	tunnelChannels.set(chanId, channel);
		attachPlayer(room);
	attempt();
}

function spineCloseChannel(chanId, notify = true) {
	const chan = tunnelChannels.get(chanId);
	if (!chan) return;
	tunnelChannels.delete(chanId);
	detachPlayer(rooms.get(chan.roomId));
	chan.destroy();
	if (notify) spineSendJson({ t: 'close', chanId });
}
function spineConnect({ candidate = false } = {}) {
	if (updateRequired) return; // a reconnect timer from before the 4003
	const url = new URL(spineUrl);
	// Preserve TLS: https/wss dial wss, only plain http downgrades to ws.
	const wsUrl = `${url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'}//${url.host}/node`;
	// §5.5: the Bearer owner token is present only for the owner tier.
	const ws = new WebSocket(wsUrl, {
		headers: spineToken ? { authorization: `Bearer ${spineToken}` } : {},
	});
	if (candidate) rotation.ws = ws;
	else spineWs = ws;
	// Each tunnel answers on its own writer, so a reply leaves on the tunnel
	// its request came in on even while a successor takes over.
	let writer = null;
	const send = obj => { if (writer) writer.send(JSON.stringify(obj)); };
	const current = () => spineWs === ws;
	ws.on('open', () => {
		console.log(`[roomhost] spine tunnel open (${spineUrl})${candidate ? ' for rotation' : ''}`);
		writer = createWsWriter(ws, {
			limitBytes: RELAY_LIMITS.tunnel,
			onFailure: why => {
				console.log(`[roomhost] ${why} — terminating spine tunnel`);
				if (why.code === 'ERR_RELAY_BACKPRESSURE') ws.terminate();
				else closeRelayWs(ws, 1011, 'relay closed');
			},
		});
		if (!candidate) tunnelWriter = writer;
		// T2.5 protocol 2: register within 5 s of open — sent at once. The
		// geo/capacity/health fields ride along for the protocol-1 relay
		// until T2.8 retires that contract.
		const cap = computeCapacity();
		send({
			t: 'register',
			proto: protocol.proto,
				nodeKey: ensureInstallKey(),
				build: buildInfo?.simBuild ?? 'unknown',
				rulesHash: process.env.REDLINE_RANKED_RULES_HASH ?? '',
				mode,
			name: nodeName,
			maxMatches,
			app: appVersion,
			geo: '',
			capacity: maxMatches,
			slots: { freeMatches: draining || rotation ? 0 : cap.freeMatches },
			health: { healthy: cap.healthy, degraded: cap.degraded },
		});
		if (!candidate) spineReportRooms();
	});
	ws.on('message', async (data, isBinary) => {
		if (isBinary) {
			// Player channel data from the spine [u16 BE chanId][payload].
			if (!current() || data.length < 2) return;
			const chanId = data.readUInt16BE(0);
			const chan = tunnelChannels.get(chanId);
			if (chan) chan.write(data.subarray(2));
			return;
		}
		let msg;
		try { msg = JSON.parse(String(data)); } catch { return; }
		if (msg.t === 'registered') {
			// T2.5: the relay accepted the registration — the backoff resets.
			spineNodeId = typeof msg.nodeId === 'string' ? msg.nodeId : spineNodeId;
			console.log(`[roomhost] registered as node ${spineNodeId ?? '?'} (tier ${msg.tier ?? '?'})`);
			reconnectDelayMs = protocol.reconnect.initialMs;
			if (candidate) {
				if (rotation?.ws !== ws) { ws.terminate(); return; } // the handover was abandoned meanwhile
				// The relay replaced the old tunnel (4002) and kept its rooms: this one is current now.
				clearTimeout(rotation.timer);
				rotation = null;
				spineWs = ws;
				tunnelWriter = writer;
				console.log('[roomhost] spine tunnel rotated');
			}
			tunnelRegisteredAt = Date.now();
			spineReportRooms();
			spineSendStatus();
		} else if (msg.t === 'create') {
			// No room is placed on a tunnel that is handing over or was replaced.
			if (!current() || rotation || updateRequired) {
				send({ t: 'create-fail', reqId: msg.reqId, error: 'no-capacity' });
				return;
			}
		const spec = validateCreate(msg, { keyed: false });
			if (spec.error) {
				send({ t: 'create-fail', reqId: msg.reqId, error: 'invalid', field: spec.field });
				return;
			}
			inFlightCreates++;
			let room;
			try {
				room = await allocateRoom(spec).catch(err => {
					if (err instanceof RunnerMissing) return { runnerMissing: err.detail };
					throw err;
				});
			} finally {
				inFlightCreates--;
			}
			if (room && room.runnerMissing) {
				send({ t: 'create-fail', reqId: msg.reqId, error: 'runner-missing', detail: room.runnerMissing });
				return;
			}
			if (room === null) {
				send({ t: 'create-fail', reqId: msg.reqId, error: 'no-capacity' });
				return;
			}
			console.log(`[roomhost] spine room ${room.id} created (map ${room.map}, port ${room.port})`);
			send({ t: 'create-ok', reqId: msg.reqId, roomId: room.id, summary: roomSummary(room) });
			spineReportRooms();
			} else if (msg.t === 'open') {
				// A channel on the outgoing tunnel would die with it; the player's
				// retry reaches the successor.
				if (!current() || rotation || updateRequired || draining) {
					send({ t: 'close', chanId: msg.chanId });
					return;
				}
				spineOpenChannel(msg.chanId, msg.roomId, { hostKey: msg.hostKey, claim: msg.claim });
		} else if (msg.t === 'close') {
			if (current()) spineCloseChannel(msg.chanId, false);
		}
		// The protocol-1 JSON ping/pong is gone (§5.5): liveness is the
		// transport-level ping, answered by the ws library itself.
	});
	ws.on('close', (code, reason) => {
		if (writer) writer.close();
		const reasonText = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '');
		if (code === 4003) {
			if (current()) {
				spineWs = null;
				lastSpineCloseCode = code;
				for (const chanId of tunnelChannels.keys()) spineCloseChannel(chanId, false);
				tunnelWriter = null;
			}
			onUpdateRequired(reasonText);
			return;
		}
		if (candidate && !current()) {
			// The successor never became current: its register was refused or the
			// dial failed. Keep the current tunnel, or reconnect if it died meanwhile.
			if (rotation?.ws === ws) {
				const { activeClosed } = rotation;
				clearTimeout(rotation.timer);
				rotation = null;
				console.log(`[roomhost] spine tunnel rotation failed (code ${code}); keeping the current tunnel`);
				if (activeClosed) setTimeout(spineConnect, protocol.reconnect.initialMs);
				else spineSendStatus();
			}
			return;
		}
		if (!current()) return; // the tunnel this node rotated away from (4002)
		spineWs = null;
		lastSpineCloseCode = code;
		for (const chanId of tunnelChannels.keys()) spineCloseChannel(chanId, false);
		tunnelWriter = null;
		if (rotation) {
			// Died mid-handover: the successor takes over once it registers, and
			// its failure starts the normal reconnect.
			rotation.activeClosed = true;
			return;
		}
		if (updateRequired) return;
		// 4004 (too many nodes from this IP) retries on a fixed 60 s cadence;
		// everything else backs off 3 s doubling to 60 s, ±20 % jitter,
		// resetting on a successful registration.
		let waitMs;
		if (code === 4004) {
			waitMs = protocol.reconnect.tooManyNodesRetryMs;
		} else {
			const jitter = 1 + (Math.random() * 2 - 1) * protocol.reconnect.jitterFraction;
			waitMs = Math.min(protocol.reconnect.maxMs, Math.round(reconnectDelayMs * jitter));
			reconnectDelayMs = Math.min(protocol.reconnect.maxMs, reconnectDelayMs * 2);
		}
		console.log(`[roomhost] spine tunnel closed (code ${code}${reasonText ? `, ${reasonText}` : ''}), reconnecting in ${Math.round(waitMs / 1000)}s…`);
		setTimeout(spineConnect, waitMs);
	});
	ws.on('error', () => { /* close follows */ });
}

// T2.5/§5.5: live status every 5 s — measured slots, health and player count
// (same cadence as the sampler so the numbers always move together).
function spineSendStatus() {
	if (!spineWs || spineWs.readyState !== WebSocket.OPEN) return;
	const cap = computeCapacity();
	spineSendJson({
		t: 'status',
		freeMatches: draining || rotation || updateRequired ? 0 : cap.freeMatches,
		healthy: cap.healthy,
		degraded: cap.degraded,
		players: [...rooms.values()].reduce((a, room) => a + room.players, 0),
		maxPlayersPerMatch: cap.degraded ? 2 : 8,
		dedicatedRssBytes: cap.dedicatedRssBytes,
	});
}
const spineStatusTimer = setInterval(spineSendStatus, protocol.nodeTunnel.statusEverySeconds * 1000);
spineStatusTimer.unref();

function tunnelIdle() {
	if (tunnelChannels.size > 0 || inFlightCreates > 0) return false;
	for (const room of rooms.values()) if (room.state !== 'lobby') return false;
	return true;
}

function maybeRotateTunnel() {
	if (rotation || draining || updateRequired || !spineWs || spineWs.readyState !== WebSocket.OPEN || tunnelRegisteredAt === 0) return;
	if (Date.now() - tunnelRegisteredAt < tunnelRotateMs || !tunnelIdle()) return;
	console.log('[roomhost] rotating spine tunnel');
	rotation = { ws: null, activeClosed: false, timer: null };
	rotation.timer = setTimeout(() => {
		if (!rotation) return;
		const { ws, activeClosed } = rotation;
		rotation = null;
		console.log('[roomhost] spine tunnel rotation timed out; keeping the current tunnel');
		try { ws?.terminate(); } catch { /* already gone */ }
		if (activeClosed) setTimeout(spineConnect, protocol.reconnect.initialMs);
		else spineSendStatus();
	}, 15_000);
	spineSendStatus(); // no free matches while the handover runs
	spineConnect({ candidate: true });
}

if (spineUrl) {
	spineConnect();
	const reportTimer = setInterval(spineReportRooms, protocol.nodeTunnel.roomsEverySeconds * 1000);
	reportTimer.unref();
	const rotateTimer = setInterval(maybeRotateTunnel, Math.max(1000, Math.min(60_000, Math.floor(tunnelRotateMs / 4))));
	rotateTimer.unref();
}

	return { muxPort: wsServer.address().port, httpPort: httpServer.address().port, bundleRoot };
}

// Direct entry: run via this file keeps every gate's command line working.
// realpath on both sides — tmpdirs and test fixtures are often symlinks
// (/var/folders -> /private/var/folders on macOS), and Node realpaths
// import.meta.url while process.argv[1] stays as given.
const entryReal = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : null;
if (entryReal && entryReal === fs.realpathSync(fileURLToPath(import.meta.url))) {
	startNode(parseArgv()).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
