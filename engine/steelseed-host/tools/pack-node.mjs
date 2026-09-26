// Build the per-OS community-server zip (T3.20): everything a volunteer needs to
// run an always-on standing node for a spine on a VPS — no source repo, no .NET
// install, no inbound port, no token.
//
//   node pack-node.mjs <rid> [--out <dir>]     (default out: dist/)
//
// <rid> is a server runtime id (osx-arm64, osx-x64, win-x64, linux-x64,
// linux-arm64) or a platform id assembleNode() maps (darwin-arm64, …).
//
// The node itself is a plain assembleNode() product (L27, T1.0): this packager
// never lists node files by hand, and nodeparitygate holds the artifact to
// exactly that assembly. On top of one fresh assembly the zip carries only:
//   rooms.example.json        the standing-mode rooms template (T3.19)
//   start-node.sh / .cmd      the thin wrapper for the zip's OS (T3.14)
//   steelthorn-node.service   the systemd unit for a VPS install (T3.20)
//   README-NODE.md            volunteer instructions
//   runtime/node.exe          the bundled Node.js runtime, win-x64 only
//   RELEASE-MANIFEST.json     public source tag and commit, build id, contents digest, licences
//                             (release-manifest.mjs); the zip's own sha256 goes beside it in
//                             <zip>.release.json
//
// Zip layout (the zip root IS the node's engine root):
//   redline-node-<rid>/
//     node-assembly.json                  assembly manifest (rid, commit, hashes)
//     steelseed-host/tools/node-cli.mjs   the node's only entry point
//     steelseed-host/generated/           the generated assetless mod + build.json
//     node_modules/ws/                    the only runtime dependency
//     bin-standalone/<rid>/               the self-contained server runtime
//     rooms.example.json  start-node.<sh|cmd>  steelthorn-node.service  README-NODE.md
//     runtime/node.exe                    (win-x64) so no Node.js install is needed
//
// NO AppBundle and no bin/: a community server serves no game page, and the zip
// is self-contained — the volunteer installs nothing at all. The packer
// fails loudly when the standalone runtime is missing or its build.json.simBuild
// differs from the generated mod's (a node on an old build is refused with 4003
// by the room-creation build check anyway — ship the build the mod was made for).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assembleNode, resolveRid } from './assemble-node.mjs';
import { releaseManifest, writeManifest, writeSidecar } from './release-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const argv = process.argv.slice(2);
const outBase = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repoRoot, 'dist'));
const ridArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');

function fail(message) {
	console.error(`pack-node: ${message}`);
	process.exit(1);
}

if (!ridArg)
	fail('usage: node pack-node.mjs <rid> [--out <dir>] — rids: osx-arm64 osx-x64 win-x64 linux-x64 linux-arm64');
let rid;
try {
	rid = resolveRid(ridArg);
} catch (err) {
	fail(err.message);
}

const stageName = `redline-node-${rid}`;
const stageRoot = path.join(outBase, stageName);
const zipPath = path.join(outBase, `${stageName}.zip`);
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(outBase, { recursive: true });

// The node: one manifest-driven assembly (T1.0). No hand-written file lists.
await assembleNode({ rid, out: stageRoot });

// T3.20: the zip must be self-contained and carry the build the generated mod
// was made for — the room-creation build check refuses anything else (4003).
const generatedBuildPath = path.join(stageRoot, 'steelseed-host/generated/build.json');
if (!fs.existsSync(generatedBuildPath))
	fail('steelseed-host/generated/build.json is missing — run "node steelseed-host/tools/build-ra-mod.mjs" first');
const standaloneBuildPath = path.join(stageRoot, 'bin-standalone', rid, 'build.json');
if (!fs.existsSync(standaloneBuildPath))
	fail(`bin-standalone/${rid} is missing — run "node tools/publish-standalone.mjs ${rid}" first; the zip must be self-contained (no .NET on the volunteer's machine)`);
const standaloneBuild = JSON.parse(fs.readFileSync(standaloneBuildPath, 'utf8'));
const generatedBuild = JSON.parse(fs.readFileSync(generatedBuildPath, 'utf8'));
if (standaloneBuild.simBuild !== generatedBuild.simBuild)
	fail(`simBuild mismatch: bin-standalone/${rid} carries ${standaloneBuild.simBuild}, the generated mod carries ${generatedBuild.simBuild} — republish the runtime or rebuild the mod`);
if (!fs.existsSync(path.join(stageRoot, 'steelseed-host/generated/mods/ra/map-catalog.json')))
	fail('the generated mod lacks map-catalog.json — run "node steelseed-host/tools/build-ra-mod.mjs" first');

// The bundled Node runtime for the Windows zip (Sept 2026): a volunteer
// without Node.js hit "'node' is not recognized" — the whole zero-config
// promise died on a missing interpreter. Shipping node.exe from the official
// pinned distribution inside runtime/ (zip ROOT, so nodeparitygate's assembly
// scan stays untouched) removes the prerequisite entirely: nothing to install,
// no PATH edits, no admin rights, works offline. The download is verified
// against nodejs.org's SHASUMS256.txt before it is staged — this binary runs
// on volunteers' machines, so a corrupt or tampered fetch must fail the pack.
const NODE_RUNTIME_VERSION = 'v24.21.0';
async function stageNodeRuntime() {
	const distName = `node-${NODE_RUNTIME_VERSION}-win-x64.zip`;
	const cacheDir = path.join(outBase, '.node-runtime');
	const distZip = path.join(cacheDir, distName);
	fs.mkdirSync(cacheDir, { recursive: true });
	if (!fs.existsSync(distZip)) {
		const url = `https://nodejs.org/dist/${NODE_RUNTIME_VERSION}/${distName}`;
		console.log(`pack-node: downloading ${url}`);
		const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
		const shasums = await (await fetch(`https://nodejs.org/dist/${NODE_RUNTIME_VERSION}/SHASUMS256.txt`)).text();
		const want = shasums.match(new RegExp(`^([0-9a-f]{64})  ${distName}$`, 'm'))?.[1];
		if (!want || crypto.createHash('sha256').update(bytes).digest('hex') !== want)
			fail(`Node runtime checksum mismatch for ${distName} — refused to stage it`);
		fs.writeFileSync(distZip, bytes);
	}
	const runtimeDir = path.join(stageRoot, 'runtime');
	fs.mkdirSync(runtimeDir, { recursive: true });
	const inner = `node-${NODE_RUNTIME_VERSION}-win-x64/`;
	// unzip -p streams a member to stdout; every OS that packs this zip
	// (CI linux, local macOS) ships unzip. node.exe is ~90 MB — maxBuffer
	// must cover it.
	for (const [member, out] of [['node.exe', 'node.exe'], ['LICENSE', 'node-LICENSE.txt']]) {
		const res = spawnSync('unzip', ['-p', distZip, inner + member], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
		if (res.status !== 0 || !res.stdout?.length)
			fail(`cannot extract ${member} from the Node runtime zip (unzip missing or a corrupt download — delete ${distZip} and retry)`);
		fs.writeFileSync(path.join(runtimeDir, out), res.stdout);
	}
}

// T3.19: the standing-mode rooms template ships at the package root; the
// default MODE (standing, set in node-cli.mjs) reads ./rooms.json and copies
// the example there itself on first start (with a unique room name), so the
// volunteer starts with zero arguments. Root placement keeps nodeparitygate's
// assembly scan (fresh-assembly roots only) untouched.
fs.copyFileSync(path.join(here, 'rooms.example.json'), path.join(stageRoot, 'rooms.example.json'));

// T3.14: the wrapper is thin — no flags, no environment handling; every default
// lives in node-cli.mjs, in one place. One wrapper per zip: the OS it targets.
// The Windows wrapper pauses on failure (refused start, …): a double-clicked
// window must stay open long enough to read the error. It runs the bundled
// runtime/node.exe, so "install Node.js" is no longer a prerequisite; PATH
// node is only a fallback for a hand-stripped package.
if (rid === 'win-x64') {
	await stageNodeRuntime();
	fs.writeFileSync(path.join(stageRoot, 'start-node.cmd'), `@echo off
REM SteelSeed node - connects to the Grid and hosts rooms for it.
REM No arguments needed: first start creates rooms.json from rooms.example.json.
REM Node.js itself is included (runtime\\node.exe) - nothing to install.
set "NODE_EXE=%~dp0runtime\\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" "%~dp0steelseed-host\\tools\\node-cli.mjs" %*
if errorlevel 1 pause
`);
} else {
	fs.writeFileSync(path.join(stageRoot, 'start-node.sh'), `#!/bin/sh
# SteelSeed node - connects to a spine and hosts rooms for it.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/steelseed-host/tools/node-cli.mjs" "$@"
`);
	fs.chmodSync(path.join(stageRoot, 'start-node.sh'), 0o755);
}

// T3.20: the systemd unit ships inside the zip — copy rooms.example.json to
// /etc/redline-node/rooms.json, generate a key for REDLINE_NODE_KEY, done.
fs.copyFileSync(path.join(here, 'systemd/steelthorn-node.service'), path.join(stageRoot, 'steelthorn-node.service'));

fs.writeFileSync(path.join(stageRoot, 'README-NODE.md'), `# SteelSeed node

Host public standing rooms for the Redline Wars Grid — an always-on community
server, the way OpenRA servers have always worked. Players reach the game
through the Grid; your machine runs the authoritative match servers and
dials out to the Grid itself. No configuration, no token, no open inbound
port.

## Requirements
- Nothing to install on Windows — the package carries its own Node.js
  runtime (\`runtime\\node.exe\`). Linux/macOS need Node.js 20 or newer.
- ~250 MB of disk, 1 GB of free RAM per room
- Outbound internet (HTTPS/WSS to the Grid — no port-forwarding, no .NET)

## Start (Windows)
1. Unzip this package anywhere (your Desktop is fine).
2. Double-click \`start-node.cmd\`.

That is all. The first start creates \`rooms.json\` from
\`rooms.example.json\` with a unique room name (your machine's hostname is
appended, e.g. "Community #1 (Office-PC)"), connects to the production Grid,
and your room appears on the Grid status page within a few seconds. If
something fails the window stays open (\`pause\`) so the error can be read.
Edit \`rooms.json\` and restart to change rooms, maps and slots — the file is
never overwritten again.

## Start (Linux/macOS)
\`\`\`sh
./start-node.sh
\`\`\`
Same zero-config behaviour as Windows. Run it from the package folder (the
folder holding \`start-node.sh\`); a terminal window that shows the node's
log is the whole UI.

## Advanced flags (all optional)
\`\`\`
--lan                run a LAN-only node: no Grid connection at all
--spine <url>        connect to a different Grid spine instead of the
                     production one (wss://spine.redlinewars.online/node)
--rooms-file <file>  use this rooms file instead of the default rooms.json
--mode <mode>        own | standing (default) | donate
--data-dir <dir>     where node.key and state live (default ~/.redline-node)
--max-matches <n>    simultaneous matches to allow
--ws/--http <port>   local mux/API ports
\`\`\`
Environment equivalents: \`SPINE_URL\`, \`ROOMS_FILE\`, \`MODE\`, \`DATA_DIR\`,
\`REDLINE_NODE_KEY\` (the per-launch local API key; generated and printed
when unset). An explicit \`--spine\` always beats \`--lan\` and \`SPINE_URL\`.

## Start (systemd, a VPS)
Unzip to /opt/redline-node, copy rooms.example.json to
/etc/redline-node/rooms.json and edit it, put a generated key
(\`openssl rand -hex 32\`) in the unit's REDLINE_NODE_KEY, then:
\`\`\`sh
systemctl daemon-reload && systemctl enable --now steelthorn-node
\`\`\`
The unit starts the node in STANDING mode with the production spine pinned
explicitly: it creates its own public rooms from the rooms file and
recreates each one after a match ends. It exits with status 3 when the spine
requires a newer build, or status 4 after an intentional drain. The unit's
\`RestartPreventExitStatus=3 4\` keeps it down until the operator completes
the update.

The node's local API (rooms/health) listens on 127.0.0.1 only and is
protected by the per-install key (REDLINE_NODE_KEY; the registration key
lives in node.key under the data directory). Match traffic is tunneled
through the spine — nothing listens on a public address.

## Files
- \`steelseed-host/tools/node-cli.mjs\` — the node's only entry point
- \`rooms.example.json\` — the rooms template (copied to \`rooms.json\`, with a
  unique room name, on the first start)
- \`steelthorn-node.service\` — the systemd unit for a VPS
- \`steelseed-host/generated/\` — the assetless mod the server loads
- \`bin-standalone/\` — the self-contained server runtime (no .NET needed)
- \`COPYING-GPLv3.txt\`, \`AUTHORS-OpenRA.txt\`, \`THIRD-PARTY-NOTICES.txt\`, \`GPL-2.0.txt\`, \`LGPL-2.1.txt\`, \`LGPL-3.0.txt\` — licences
- \`RELEASE-MANIFEST.json\` — the public source tag and commit this package was built from

## Licence
The node, its server and the engine are free software under the GNU GPL v3 or later, built on
OpenRA (c) The OpenRA Developers and Contributors. Source:
https://github.com/jolynstudios/redlinewars. Redline Wars (c) 2026 Jolyn Studios. EA has not
endorsed and does not support this product.
`);

// Licences travel with every node zip (GPL engine and server, OpenRA's authors, notices, and the
// licences of the bundled libraries: GPL v2, LGPL v2.1, LGPL v3).
for (const [from, to] of [['COPYING', 'COPYING-GPLv3.txt'], ['AUTHORS', 'AUTHORS-OpenRA.txt'], ['../THIRD_PARTY_NOTICES.md', 'THIRD-PARTY-NOTICES.txt'],
	['licenses/GPL-2.0.txt', 'GPL-2.0.txt'], ['licenses/LGPL-2.1.txt', 'LGPL-2.1.txt'], ['licenses/LGPL-3.0.txt', 'LGPL-3.0.txt']])
	fs.copyFileSync(path.resolve(here, '..', '..', from), path.join(stageRoot, to));

// compliance.md §3: the release manifest names the public source of this exact zip.
const manifest = releaseManifest({
	artifact: `${stageName}.zip`,
	kind: 'node-zip',
	rid,
	build: generatedBuild,
	contents: { node: stageRoot },
	licenseTexts: ['COPYING-GPLv3.txt', 'AUTHORS-OpenRA.txt', 'THIRD-PARTY-NOTICES.txt', 'GPL-2.0.txt', 'LGPL-2.1.txt', 'LGPL-3.0.txt'],
});
writeManifest(stageRoot, manifest);

// The deliverable: one zip per RID. Info-ZIP keeps the wrapper's exec bit;
// unzip restores it.
const zip = spawnSync('zip', ['-rq', `${stageName}.zip`, stageName], { cwd: outBase });
if (zip.error || zip.status !== 0)
	fail(`zipping failed (${zip.error ? zip.error.message : `exit ${zip.status}`}) — is Info-ZIP's "zip" installed?`);
fs.rmSync(stageRoot, { recursive: true, force: true });
writeSidecar(zipPath, manifest);

const mb = Math.round(fs.statSync(zipPath).size / 1e6);
console.log(`pack-node: ${zipPath} (${mb} MB, rid ${rid}, source ${manifest.source.tag ?? manifest.source.commit.slice(0, 12)}${manifest.source.dirty ? ', DIRTY' : ''})`);
