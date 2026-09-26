#!/usr/bin/env node
// The node's only entry point (L27, §4.7, T1.0): every default, flag and environment
// name lives here and nowhere else. roomhost.mjs still calls startNode(parseArgv())
// when run directly, so every gate keeps its command line.
//
// Flags:  --spine <url>  --mode <own|standing|donate>  --rooms-file <file>
//         --node-key-file <file>  --name <node name>
//         --max-matches <n>  --data-dir <dir>  --lan  --bundle <dir>
//         --ws <mux port>  --http <api port>  --idle-kill <seconds>
//         --exit-on-update-required  --exit-on-drain
//         --token is rejected: secrets never appear in argv (T2.5).
// Zero-config defaults (the community zip starts with no arguments):
//   spine   wss://spine.redlinewars.online/node (the production Grid) unless
//           --lan opts back into a LAN-only node (no spine connection);
//           an explicit --spine (or SPINE_URL) always wins.
//   rooms   standing mode reads rooms.json from the working directory, then
//           the package root; on first start an existing rooms.example.json
//           is copied to rooms.json ONCE with the machine hostname appended
//           to every room name so each install's rooms are unique.
// Env:    SPINE_URL  MODE  ROOMS_FILE  MAX_MATCHES  DATA_DIR
//         REDLINE_NODE_KEY  — the per-launch local API key (§5.3, hex);
//         when unset the CLI generates one and prints it.
//         REDLINE_NODE_TOKEN (owner token; legacy fallbacks NODE_TOKEN,
//         STEELSEED_SPINE_TOKEN)
// The per-install REGISTRATION key (§5.5, base64url, mode 0600) lives in
// --node-key-file (default <dataDir>/node.key) and is created when missing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// NOTE: roomhost.mjs does not export startNode/parseArgv yet; that export lands with
// the T1.0 wiring edit (until then this entry point cannot run).
import { startNode, parseArgv } from './roomhost.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const protocol = JSON.parse(fs.readFileSync(path.join(scriptDir, 'protocol.json'), 'utf8'));

function readArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i];
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      out.values[name] = argv[i + 1];
      i++;
    } else out.flags.add(name);
  }
  return out;
}

// Parses this CLI's documented flags; flags roomhost.mjs established (--public,
// --origin, --geo, --base-port, --dedicated, …) survive through parseArgv() below.
function parseCliArgs(argv) {
  const { flags, values } = readArgs(argv);
  const num = (name) => (values[name] !== undefined ? Number(values[name]) : undefined);
  return {
    spineUrl: values['--spine'],
    mode: values['--mode'],
    roomsFile: values['--rooms-file'],
    nodeKeyFile: values['--node-key-file'],
    name: values['--name'],
    maxMatches: num('--max-matches'),
    dataDir: values['--data-dir'],
    bundle: values['--bundle'],
    muxPort: num('--ws'),
    httpPort: num('--http'),
    basePort: num('--base-port'),
    idleKillSeconds: num('--idle-kill'),
    lan: flags.has('--lan') || undefined,
    exitOnUpdateRequired: flags.has('--exit-on-update-required') || undefined,
    exitOnDrain: flags.has('--exit-on-drain') || undefined,
  };
}

// §5.5: the registration key is created once per install and stored at
// <dataDir>/node.key (mode 0600); 32 random bytes as base64url = 43 chars.
function ensureNodeKeyFile(explicitFile, dataDir) {
  const keyPath = explicitFile ?? path.join(dataDir, 'node.key');
  try {
    if (fs.readFileSync(keyPath, 'utf8').trim()) return keyPath;
  } catch {
    // not there yet — create it below
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  return keyPath;
}

// The zero-config spine (T3.20 community zip): a node started with no
// arguments joins the production Grid. --lan opts back into the old
// LAN-only behaviour (no spine connection); an explicit --spine wins.
const PRODUCTION_SPINE_URL = 'wss://spine.redlinewars.online/node';

// A short, filename- and chat-safe label for the first-run room names:
// "Community #1" on a MacBook-Pro-2 becomes "Community #1 (MacBook-Pro-2)".
function hostnameLabel(hostname) {
  const cleaned = String(hostname ?? '')
    .replace(/\.local$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return cleaned || crypto.randomBytes(2).toString('hex');
}

// First start: rooms.json does not exist yet but rooms.example.json does —
// copy it ONCE, appending the label to every room name so each install's
// rooms are unique on the Grid (the copy is never repeated, so later edits
// to rooms.json survive). The suffixed name stays inside the protocol's
// room-name cap (roomhost refuses longer names at boot).
const ROOM_NAME_MAX_CHARS = protocol.lanBeacon?.nameMaxChars ?? 32;

function suffixedRoomName(name, label) {
  if (name.length + label.length + 3 <= ROOM_NAME_MAX_CHARS) return `${name} (${label})`;
  const roomForLabel = ROOM_NAME_MAX_CHARS - name.length - 3;
  if (roomForLabel >= 1) return `${name} (${label.slice(0, roomForLabel)})`;
  return name; // the template name already fills the cap — leave it for the owner to edit
}

function createRoomsFileFromExample(examplePath, roomsPath, hostname) {
  const doc = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  const label = hostnameLabel(hostname);
  if (Array.isArray(doc?.rooms))
    for (const room of doc.rooms)
      if (room && typeof room.name === 'string' && room.name) room.name = suffixedRoomName(room.name, label);
  fs.writeFileSync(roomsPath, `${JSON.stringify(doc, null, 2)}\n`);
  return label;
}

// Standing mode's rooms file, defaulted for the unpack-and-run zip: the
// working directory first (double-click start-node.cmd, ./start-node.sh),
// then the package root (the zip layout, wherever the node was started
// from). Returns the resolved path, or throws when nothing can be used.
function defaultRoomsFile(mode, cliRooms, envRooms, { cwd, packageRoot, hostname }) {
  const explicit = cliRooms ?? envRooms;
  if (explicit || mode !== 'standing') return explicit;
  const dirs = [...new Set([cwd, packageRoot])];
  for (const dir of dirs) {
    const roomsPath = path.join(dir, 'rooms.json');
    if (fs.existsSync(roomsPath)) return roomsPath;
  }
  for (const dir of dirs) {
    const examplePath = path.join(dir, 'rooms.example.json');
    if (!fs.existsSync(examplePath)) continue;
    const roomsPath = path.join(dir, 'rooms.json');
    const label = createRoomsFileFromExample(examplePath, roomsPath, hostname);
    console.log(
      `[node-cli] first run: created ${roomsPath} from ${examplePath} — room names carry the suffix "(${label})" so your rooms are unique on the Grid; edit rooms.json to customize them`,
    );
    return roomsPath;
  }
  throw new Error(
    `node-cli: standing mode (the default) needs a rooms file — none found in ${dirs.join(' or ')} — put rooms.json (or rooms.example.json, copied automatically on first start with a unique room name) there, or pass --rooms-file <file> or set ROOMS_FILE`,
  );
}

export function buildOptions(argv, env, runtime = {}) {
  const legacyTokenArg = argv.includes('--token');
  if (legacyTokenArg)
    throw new Error(
      'node-cli: --token is no longer accepted; set REDLINE_NODE_TOKEN in the environment (secrets must never appear in argv)',
    );

  const cli = parseCliArgs(argv);
  const dataDir = cli.dataDir ?? env.DATA_DIR ?? path.join(os.homedir(), '.redline-node');
  // T3.19: the shipped default is STANDING — an always-on community server
  // whose rooms come from a rooms file. The start scripts pass nothing; the
  // desktop shell pins --mode own explicitly (T3.4). T3.14: this default
  // lives here and nowhere else.
  const mode = cli.mode ?? env.MODE ?? 'standing';
  if (!protocol.nodeModes.includes(mode))
    throw new Error(`node-cli: unknown mode "${mode}" (expected one of ${protocol.nodeModes.join(', ')})`);
  const roomsFile = defaultRoomsFile(mode, cli.roomsFile, env.ROOMS_FILE, {
    cwd: runtime.cwd ?? process.cwd(),
    packageRoot: runtime.packageRoot ?? path.resolve(scriptDir, '../..'),
    hostname: runtime.hostname ?? os.hostname(),
  });

  const idleKillRaw = cli.idleKillSeconds;
  const idleKillSeconds = Math.max(
    protocol.timeouts.idleKillFloorSeconds,
    idleKillRaw ?? protocol.timeouts.idleKillDefaultSeconds,
  );

  return {
    // argv layer first so it wins over parseArgv()'s baseline, then env, then defaults
    spineUrl: cli.spineUrl ?? (cli.lan ? null : (env.SPINE_URL ?? PRODUCTION_SPINE_URL)),
    mode,
    roomsFile,
    dataDir,
    maxMatches: cli.maxMatches ?? (env.MAX_MATCHES ? Number(env.MAX_MATCHES) : undefined),
    bundle: cli.bundle ?? undefined,
    muxPort: cli.muxPort ?? protocol.ports.nodeMux,
    // T3.14 regression fix: --http must reach startNode — dropping it made
    // the local API bind 8331 while the desktop shell polls protocol.ports
    // .nodeApi, so every host-start timed out on /v2/health.
    httpPort: cli.httpPort ?? protocol.ports.nodeApi,
    basePort: cli.basePort ?? protocol.ports.dedicatedBase,
    // §5.3: the local API key is per-launch (env, never argv); when the
    // launcher did not supply one the CLI generates it and says so.
    nodeKey: env.REDLINE_NODE_KEY ?? crypto.randomBytes(32).toString('hex'),
    nodeKeyFile: ensureNodeKeyFile(cli.nodeKeyFile, dataDir),
    name: cli.name,
    idleKillSeconds,
    // --lan in standing mode only means "no spine connection" (see spineUrl
    // above): roomhost refuses the LAN mux and beacon in standing mode
    // (T3.19), so the flag is not forwarded there. Every other mode (the
    // desktop shell's --mode own --lan) keeps the established behaviour.
    lan: mode === 'standing' ? undefined : cli.lan,
    exitOnUpdateRequired: cli.exitOnUpdateRequired,
    exitOnDrain: cli.exitOnDrain,
    ownerToken: env.REDLINE_NODE_TOKEN ?? env.NODE_TOKEN ?? env.STEELSEED_SPINE_TOKEN ?? null,
  };
}

// realpath on both sides: Node canonicalises import.meta.url while
// process.argv[1] stays as given (macOS /tmp → /private/tmp, tmpdir fixtures).
const entryReal = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : null;
if (entryReal && entryReal === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const options = buildOptions(process.argv.slice(2), process.env);
  if (!process.env.REDLINE_NODE_KEY)
    console.log(`[node-cli] REDLINE_NODE_KEY unset — generated per-launch local API key: ${options.nodeKey}`);
  startNode(options).catch(err => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
