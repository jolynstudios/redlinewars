// Build the distributable Steelthorn node:
//   dist/steelthorn-node/            npm package (node code + generated mod)
//     -> npm pack => steelthorn-node-1.0.0.tgz   (publish/install this)
//   dist/steelthorn-node-assets.tar.gz           heavy artifacts (~150 MB):
//     bin/ (desktop server runtime) and AppBundle/ (client for players)
//
// The volunteer flow:
//   npm install -g steelthorn-node.tgz
//   SPINE_URL=wss://spine.example/node ASSETS_URL=https://releases.example/steelthorn-node-assets.tar.gz steelthorn-node
// The bin entry IS the node's only entry point (node-cli.mjs, T1.0); the
// heavy-asset download before first start is node-cli.mjs' pre-step
// (ASSETS_URL, T3.14) — this packager carries no CLI of its own.
//
// The node inside the package is a plain assembleNode() product (L27): this
// packager never lists node files by hand, and nodeparitygate holds the
// package to exactly that assembly.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleNode } from './assemble-node.mjs';
import { releaseManifest, writeManifest } from './release-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const engineRoot = path.join(repoRoot, 'engine');
const outRoot = path.resolve(repoRoot, 'dist/steelthorn-node');
const assetsTar = path.resolve(repoRoot, 'dist/steelthorn-node-assets.tar.gz');

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

// The node: one manifest-driven assembly (T1.0). No hand-written file lists.
await assembleNode({ rid: `${process.platform}-${process.arch}`, out: outRoot });
// T3.19: the standing-mode rooms template ships at the package root; the
// default MODE (standing, set in node-cli.mjs) needs a rooms file, so the
// volunteer copies the example and points ROOMS_FILE at it.
fs.copyFileSync(path.join(here, 'rooms.example.json'), path.join(outRoot, 'rooms.example.json'));

// ---- npm package.json (ws ships as a real dependency: npm strips a vendored
// node_modules/ from published tarballs; no `files` list — the package dir IS
// the node assembly plus the systemd units and README) ----
fs.mkdirSync(path.join(outRoot, 'systemd'), { recursive: true });
fs.cpSync(path.join(engineRoot, 'steelseed-host/tools/systemd/steelthorn-node.service'), path.join(outRoot, 'systemd/steelthorn-node.service'));
fs.cpSync(path.join(engineRoot, 'steelseed-host/tools/systemd/steelthorn-spine.service'), path.join(outRoot, 'systemd/steelthorn-spine.service'));
// The engine and server are GPL: the licence, OpenRA's authors and the third-party notices ship
// with the package.
fs.copyFileSync(path.join(engineRoot, 'COPYING'), path.join(outRoot, 'COPYING'));
fs.copyFileSync(path.join(engineRoot, 'AUTHORS'), path.join(outRoot, 'AUTHORS'));
fs.copyFileSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), path.join(outRoot, 'THIRD-PARTY-NOTICES.txt'));
for (const name of ['GPL-2.0.txt', 'LGPL-2.1.txt', 'LGPL-3.0.txt']) fs.copyFileSync(path.join(engineRoot, 'licenses', name), path.join(outRoot, name));
fs.writeFileSync(path.join(outRoot, 'package.json'), JSON.stringify({
	name: '@steelthorn/node',
	version: '1.0.0',
	publishConfig: { access: 'public' },
	description: 'Steelthorn (codename SteelSeed) volunteer node: hosts rooms and authoritative match servers for a Steelthorn spine.',
	license: 'GPL-3.0-or-later',
	type: 'module',
	bin: { 'steelthorn-node': 'steelseed-host/tools/node-cli.mjs' },
	dependencies: { ws: '^8.18.0' },
	engines: { node: '>=18' },
	preferGlobal: true,
}, null, 2));

fs.writeFileSync(path.join(outRoot, 'README-NODE.md'), `# steelthorn-node

Volunteer node for a Steelthorn spine: hosts rooms and authoritative match
servers. Players connect through the spine; your machine dials OUT to it, so
no port-forwarding is needed.

## Requirements
- Node.js 18+
- .NET 8 runtime (dotnet on PATH) — only when the package carries no
  self-contained runtime for your platform
- ~400 MB disk for the node assets (downloaded on first start)

## Start
\`\`\`sh
npm install -g ./steelthorn-node-1.0.0.tgz
export SPINE_URL=wss://<spine-address>/node
export ASSETS_URL=https://<releases>/steelthorn-node-assets.tar.gz
cp "$(npm root -g)/@steelthorn/node/rooms.example.json" ./rooms.json
steelthorn-node
\`\`\`
Windows: same variables, \`steelthorn-node\` after \`npm i -g\`.

The node boots in STANDING mode (T3.19): an always-on community server that
creates its own rooms from the rooms file — copy \`rooms.example.json\` (as
above) and edit names/slots/maps to taste. Set \`MODE=own\` for a plain
player-hosted node.

The node's local API (rooms/status) listens on 127.0.0.1 only and is
protected by a per-install key (node.key under the node data directory).
The status page: \`http://127.0.0.1:14711/status\` (rooms, players, spine
state, live log).
`);

// ---- assets tarball (heavy: server runtime + client; the generated mod and
// the ws dependency ship inside the npm package) ----
if (process.argv.includes('--with-assets')) {
	const staging = path.resolve(repoRoot, 'dist/steelthorn-node-assets');
	fs.rmSync(staging, { recursive: true, force: true });
	fs.cpSync(path.join(engineRoot, 'bin'), path.join(staging, 'bin'), { recursive: true });
	fs.cpSync(path.join(engineRoot, 'bin-browser/AppBundle'), path.join(staging, 'AppBundle'), { recursive: true });
	const r = spawnSync('tar', ['-czf', assetsTar, '-C', staging, '.']);
	if (r.status !== 0) throw new Error('assets tar failed');
	fs.rmSync(staging, { recursive: true, force: true });
	console.log(`pack-npm: assets tarball ${assetsTar}`);
}

// compliance.md §3: the release manifest names the public source of this package. `npm pack`
// names the tarball after the package: @steelthorn/node@1.0.0 -> steelthorn-node-1.0.0.tgz;
// "node release-manifest.mjs <tgz>" writes its <tgz>.release.json afterwards.
const pkg = JSON.parse(fs.readFileSync(path.join(outRoot, 'package.json'), 'utf8'));
writeManifest(outRoot, releaseManifest({
	artifact: `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`,
	kind: 'npm-node',
	build: JSON.parse(fs.readFileSync(path.join(outRoot, 'steelseed-host/generated/build.json'), 'utf8')),
	// npm strips node_modules/ from the tarball (ws installs as a dependency instead).
	contents: { node: { dir: outRoot, skip: ['node_modules/'] } },
	licenseTexts: ['COPYING', 'AUTHORS', 'THIRD-PARTY-NOTICES.txt', 'GPL-2.0.txt', 'LGPL-2.1.txt', 'LGPL-3.0.txt'],
}));

console.log(`pack-npm: npm package ${outRoot} — run "npm pack" inside it, volunteers: npm i -g <tgz>`);
