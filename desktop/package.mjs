// One packaging entry (T3.13): `npm run package` → `node package.mjs [mac|win|linux]`
// (default: the host OS). Packaging never builds (AGENTS.md rule 5): this
// script VALIDATES the inputs, assembles the node per target RID with the one
// assembler (assembleNode, T1.0 — no node file is ever listed by hand, L27),
// and hands electron-builder a config whose extraResources maps exactly that
// one staged directory to steelseed-node. Public artifacts are named here too,
// so the download page and release publisher can never depend on hand-made aliases.
//
// Preflight, failing loudly with the missing piece:
//   - engine/bin-browser/AppBundle present and not older than web/dist
//   - engine/bin-standalone/<rid>/build.json.simBuild === AppBundle simBuild
//     for every RID of the target (published by engine/tools/publish-standalone.mjs)
//   - engine/steelseed-host/generated/mods/ra/map-catalog.json present
//   - every licence text shipped in resources/legal/ present (legalResources)
//
// Every package carries resources/RELEASE-MANIFEST.json (compliance.md §3: the public source tag
// and commit, build id, contents digest and licences), and every finished artifact gets its
// sha256 beside it in dist/<artifact>.release.json.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleNode } from '../engine/steelseed-host/tools/assemble-node.mjs';
import { MANIFEST_NAME, releaseManifest, writeManifest, writeSidecar } from '../engine/steelseed-host/tools/release-manifest.mjs';
import { LEGAL_DOCS, LEGAL_SOURCES } from './shell-options.mjs';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '..');
const engineRoot = path.join(repoRoot, 'engine');
const appBundle = path.join(engineRoot, 'bin-browser/AppBundle');
const sourceServer = path.join(engineRoot, 'OpenRA.Browser/tests/server.mjs');
const mapCatalog = path.join(engineRoot, 'steelseed-host/generated/mods/ra/map-catalog.json');
const standaloneDir = path.join(engineRoot, 'bin-standalone');

const TARGET_RIDS = {
  mac: ['osx-arm64', 'osx-x64'],
  win: ['win-x64'],
  linux: ['linux-x64', 'linux-arm64'],
};

export const PUBLIC_ARTIFACTS = Object.freeze({
  win: Object.freeze({ x64: 'Redline-Wars-Windows-x64-Setup.exe' }),
  linux: Object.freeze({
    x64: 'Redline-Wars-Linux-x64.AppImage',
    arm64: 'Redline-Wars-Linux-arm64.AppImage',
  }),
  mac: Object.freeze({
    arm64: 'Redline-Wars-macOS-arm64.zip',
    x64: 'Redline-Wars-macOS-x64.zip',
  }),
});

export function targetForPlatform(platform = process.platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  if (platform === 'linux') return 'linux';
  return null;
}

function readSimBuild(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).simBuild ?? null;
  } catch {
    return null;
  }
}

export function appBundleAudioAssets(bundleDir = appBundle) {
  const found = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:mp3|m4a)$/i.test(entry.name)) found.push(file);
    }
  };
  walk(bundleDir);
  return found;
}

// §3.1: every installer carries the licence texts in resources/legal/ — the
// GPLv3 text and OpenRA's AUTHORS, the app's own licence, the third-party
// notices and the font OFLs. shell-options.mjs names both ends, so the
// shell's licence viewer reads exactly what ships.
export function legalResources() {
  return Object.keys(LEGAL_DOCS).map(name => ({
    from: path.join(repoRoot, ...LEGAL_SOURCES[name].split('/')),
    to: `legal/${LEGAL_DOCS[name]}`,
  }));
}

// Returns the list of preflight failures for a target (empty = good to build).
export function validateTarget(target) {
  const failures = [];
  for (const { from, to } of legalResources()) {
    if (!fs.existsSync(from)) failures.push(`licence text missing: ${from} — every installer ships it as resources/${to}`);
  }
  const appIndex = path.join(appBundle, 'steelseed/index.html');
  if (!fs.existsSync(appIndex)) {
    failures.push(`AppBundle missing: ${appBundle} — run the web build + compose first`);
    return failures; // the simBuild comparison below needs it
  }
  const audio = appBundleAudioAssets();
  if (!audio.some(file => /\.m4a$/i.test(file)) || !audio.some(file => /\.mp3$/i.test(file)))
    failures.push(`AppBundle audio incomplete: expected .m4a and .mp3 assets under ${appBundle}`);
  const webDist = path.join(repoRoot, 'web/dist/index.html');
  if (fs.existsSync(webDist) && fs.statSync(webDist).mtimeMs > fs.statSync(appIndex).mtimeMs)
    failures.push('AppBundle is stale: web/dist is newer — run the web build + compose first');
  if (!fs.existsSync(mapCatalog))
    failures.push(`map catalog missing: ${mapCatalog} — run the generated mod build first`);
  if (!fs.existsSync(sourceServer))
    failures.push(`desktop HTTP server missing: ${sourceServer} — packaging cannot serve the AppBundle`);
  const bundleSimBuild = readSimBuild(path.join(appBundle, 'steelseed/build.json'));
  for (const rid of TARGET_RIDS[target]) {
    const buildJson = path.join(standaloneDir, rid, 'build.json');
    if (!fs.existsSync(buildJson)) {
      failures.push(`bin-standalone/${rid}/build.json missing — run: node engine/tools/publish-standalone.mjs ${rid}`);
      continue;
    }
    const ridSimBuild = readSimBuild(buildJson);
    if (ridSimBuild == null)
      failures.push(`bin-standalone/${rid}/build.json does not parse — republish: node engine/tools/publish-standalone.mjs ${rid}`);
    else if (ridSimBuild !== bundleSimBuild)
      failures.push(`bin-standalone/${rid} simBuild ${ridSimBuild} != AppBundle simBuild ${bundleSimBuild} — republish: node engine/tools/publish-standalone.mjs ${rid}`);
  }
  return failures;
}

// The staged node for one RID: a plain assembleNode() product, so the node
// inside every artifact is byte-comparable via nodeparitygate (T1.0, L27).
async function stageNode(rid) {
  const out = path.join(here, 'dist', 'node-staging', rid);
  fs.rmSync(out, { recursive: true, force: true });
  await assembleNode({ rid, out });
  return out;
}

export function verifyPackagedResources(resourcesDir, rid) {
  const required = [
    'server.mjs',
    MANIFEST_NAME,
    'AppBundle/steelseed/index.html',
    'AppBundle/steelseed/build.json',
    'steelseed-node/node-assembly.json',
    `steelseed-node/bin-standalone/${rid}/${rid.startsWith('win') ? 'OpenRA.Server.exe' : 'OpenRA.Server'}`,
    `steelseed-node/bin-standalone/${rid}/ranked-replay-verifier/${rid.startsWith('win') ? 'Steelseed.RankedReplayVerifier.exe' : 'Steelseed.RankedReplayVerifier'}`,
    ...legalResources().map(resource => resource.to),
  ];
  for (const rel of required) {
    if (!fs.existsSync(path.join(resourcesDir, rel)))
      throw new Error(`${rid} package missing ${rel} in ${resourcesDir}`);
  }
  const bundleBuild = readSimBuild(path.join(resourcesDir, 'AppBundle/steelseed/build.json'));
  const serverBuild = readSimBuild(path.join(resourcesDir, 'steelseed-node/bin-standalone', rid, 'build.json'));
  if (!bundleBuild || bundleBuild !== serverBuild)
    throw new Error(`${rid} package simBuild mismatch: AppBundle=${bundleBuild}, server=${serverBuild}`);
  const parity = spawnSync(process.execPath,
    [path.join(engineRoot, 'steelseed-host/tools/nodeparitygate.mjs'),
      path.join(resourcesDir, 'steelseed-node')], { stdio: 'inherit' });
  if (parity.status !== 0)
    throw new Error(`${rid} package nodeparitygate failed (${parity.status ?? parity.error?.code})`);
}

// Programmatic build — config comes from here, package.json carries none.
// electron-builder 26 takes explicit targets+arch via Platform.createTarget().
async function electronBuild(platformName, targetName, archName, config) {
  const { build, Platform, Arch } = await import('electron-builder');
  const platform = { mac: Platform.MAC, win: Platform.WINDOWS, linux: Platform.LINUX }[platformName];
  const arch = archName === 'arm64' ? Arch.arm64 : Arch.x64;
  // electron-builder resolves package.json from projectDir, never from the
  // inherited cwd — the CI packaging job runs this script from the repo root.
  await build({ targets: platform.createTarget(targetName, arch), config, projectDir: here });
}

function appPaths(target) {
  if (target === 'mac') return ['dist/mac-arm64/Redline Wars.app', 'dist/mac/Redline Wars.app'];
  return [];
}

// The npm modules assembleNode staged for the node, one directory name per
// entry — the input for the per-module extraResources copies below.
function stagedNodeModules(nodeStaging) {
  const dir = path.join(nodeStaging, 'node_modules');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

// Fresh object per call: electron-builder's config merge MUTATES the arrays it
// is handed (string file entries are consumed in place), so a shared config
// would poison the second build() of the same run.
// Pure and exported so the win/linux configs can be inspected structurally
// (CI validation) without building them.
export function targetConfig(target, nodeStaging, archName = 'x64', manifestDir = null) {
  return {
    appId: 'nl.jolynstudios.redlinewars',
    productName: 'Redline Wars',
    // Installer / Info.plist / exe metadata: the app is ours (GPLv3 or later), the engine OpenRA's.
    copyright: '© 2026 Jolyn Studios · Engine: OpenRA (GPLv3)',
    files: ['main.mjs', 'settings.mjs', 'update-gate.mjs', 'preload.cjs', 'account-broker.mjs', 'donate-hosting.mjs', 'shell-options.mjs', 'build/icon.png', 'shell/**'],
    directories: { output: 'dist' },
    extraResources: [
      { from: appBundle, to: 'AppBundle' },
      // electron-builder 26 resolves any directory named node_modules through
      // the PROJECT's dependency graph — desktop/package.json declares none, so
      // a single staging entry silently dropped the node's `ws` from every
      // desktop artifact (nodeparitygate, run 35989811458). The root entry
      // skips node_modules; each staged module ships as its own filtered
      // entry, which the copier treats as a plain directory.
      { from: nodeStaging, to: 'steelseed-node', filter: ['**/*', '!node_modules'] },
      ...stagedNodeModules(nodeStaging).map(name => ({
        from: path.join(nodeStaging, 'node_modules', name),
        to: `steelseed-node/node_modules/${name}`,
        filter: ['**/*'],
      })),
      // main.mjs spawns <resources>/server.mjs to serve the AppBundle on
      // 127.0.0.1 — without it the packaged game page can never load.
      { from: sourceServer, to: 'server.mjs' },
      ...legalResources(),
      ...(manifestDir ? [{ from: path.join(manifestDir, MANIFEST_NAME), to: MANIFEST_NAME }] : []),
    ],
    ...(target === 'mac' && {
      mac: {
        target: 'dir',
        identity: null,
        category: 'public.app-category.games',
        icon: 'build/icon.icns',
        extendInfo: { NSLocalNetworkUsageDescription: 'Redline Wars looks for games on your local network.' },
      },
    }),
    ...(target === 'win' && {
      win: {
        target: ['nsis'],
        artifactName: PUBLIC_ARTIFACTS.win[archName],
        icon: 'build/icon.ico',
      },
      nsis: {
        oneClick: false,
        perMachine: true,
        include: 'build/installer.nsh',
      },
    }),
    ...(target === 'linux' && {
      linux: {
        target: ['AppImage'],
        artifactName: PUBLIC_ARTIFACTS.linux[archName],
        category: 'Game',
        icon: 'build/icon.png',
      },
    }),
  };
}

// The release manifest of one package, staged for extraResources before electron-builder runs.
function stageManifest(target, archName, rid, nodeStaging) {
  const dir = path.join(here, 'dist', 'manifest-staging', rid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const manifest = releaseManifest({
    artifact: PUBLIC_ARTIFACTS[target][archName],
    kind: 'desktop',
    rid,
    build: JSON.parse(fs.readFileSync(path.join(appBundle, 'steelseed/build.json'), 'utf8')),
    contents: { appBundle, node: nodeStaging },
    licenseTexts: legalResources().map(resource => resource.to),
  });
  writeManifest(dir, manifest);
  return { dir, manifest };
}

async function packageMac() {
  const manifests = {};
  for (const arch of ['arm64', 'x64']) {
    const rid = arch === 'arm64' ? 'osx-arm64' : 'osx-x64';
    // The Mac's .NET apphost needs an explicit signature to launch. Sign the
    // existing standalone binary BEFORE the one node assembler copies it, so
    // node-assembly.json and the app both hash the exact executable shipped.
    // Codesigning is a packaging step; this does not rebuild the server.
    const standaloneServer = path.join(standaloneDir, rid, 'OpenRA.Server');
    if (!fs.existsSync(standaloneServer)) throw new Error(`macOS standalone server missing: ${standaloneServer}`);
    for (const [label, args] of [
      ['sign standalone server', ['--force', '--sign', '-', standaloneServer]],
      ['verify standalone server', ['--verify', '--strict', standaloneServer]],
    ]) {
      const result = spawnSync('codesign', args, { stdio: 'inherit' });
      if (result.status !== 0)
        throw new Error(`macOS ${rid} ${label} failed (${result.status ?? result.error?.code})`);
    }
    const nodeStaging = await stageNode(rid);
    const { dir, manifest } = stageManifest('mac', arch, rid, nodeStaging);
    manifests[arch] = manifest;
    await electronBuild('mac', 'dir', arch, targetConfig('mac', nodeStaging, arch, dir));
  }
  // Seal the outer app around the already-signed child. Apple Silicon refuses
  // an unsigned .NET apphost inside Resources (SIGKILL before TCP listen).
  for (const [index, rel] of appPaths('mac').entries()) {
    const appPath = path.join(here, rel);
    if (!fs.existsSync(appPath)) throw new Error(`macOS app missing after packaging: ${appPath}`);
    const rid = TARGET_RIDS.mac[index];
    const server = path.join(appPath, 'Contents/Resources/steelseed-node/bin-standalone', rid, 'OpenRA.Server');
    if (!fs.existsSync(server)) throw new Error(`macOS dedicated server missing: ${server}`);
    for (const [label, args] of [
      ['verify dedicated server', ['--verify', '--strict', server]],
      ['sign app', ['--force', '--deep', '--sign', '-', appPath]],
      ['verify app', ['--verify', '--deep', '--strict', appPath]],
      ['verify sealed dedicated server', ['--verify', '--strict', server]],
    ]) {
      const result = spawnSync('codesign', args, { stdio: 'inherit' });
      if (result.status !== 0)
        throw new Error(`macOS ${rid} ${label} failed (${result.status ?? result.error?.code})`);
    }
    verifyPackagedResources(path.join(appPath, 'Contents/Resources'), rid);
    spawnSync('xattr', ['-cr', appPath]);
  }
  // Beta notes for the receiving Mac (the host-for-others helper and the
  // quarantine-fix helper of earlier dev builds are gone, A14/T3.13 item 7).
  const leemmijDir = path.join(here, 'dist/mac-arm64');
  fs.mkdirSync(leemmijDir, { recursive: true });
  fs.writeFileSync(path.join(leemmijDir, 'LEEMMIJ.txt'), [
    'Redline Wars beta (Mac)',
    '',
    'Spelen:',
    '  1. "Redline Wars.app" in je Programma\'s (of waar dan ook) zetten.',
    '  2. Openen (rechtsklik -> Openen bij de eerste keer).',
    '',
    'Staat de app "beschadigd" op een andere Mac? Dat is de quarantaine-',
    'vlag van het overzetten (dev-build, dus geen notarisatie). Met de',
    'terminal:  xattr -cr "/pad/naar/Redline Wars.app"',
    '',
  ].join('\n'));

  // electron-builder's `dir` target is intentional: sign the final .app first,
  // then archive that exact signed directory under the public release name.
  // `ditto` is the macOS-native zip lane and preserves the app bundle metadata.
  for (const arch of ['arm64', 'x64']) {
    const appPath = path.join(here, arch === 'arm64'
      ? 'dist/mac-arm64/Redline Wars.app'
      : 'dist/mac/Redline Wars.app');
    const artifact = path.join(here, 'dist', PUBLIC_ARTIFACTS.mac[arch]);
    fs.rmSync(artifact, { force: true });
    const zip = spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, artifact], { stdio: 'inherit' });
    if (zip.status !== 0)
      throw new Error(`ditto failed while creating ${path.basename(artifact)} (exit ${zip.status ?? zip.error?.code})`);
    writeSidecar(artifact, manifests[arch]);
  }
}

async function packageWin() {
  const nodeStaging = await stageNode('win-x64');
  const { dir, manifest } = stageManifest('win', 'x64', 'win-x64', nodeStaging);
  await electronBuild('win', 'nsis', 'x64', targetConfig('win', nodeStaging, 'x64', dir));
  verifyPackagedResources(path.join(here, 'dist/win-unpacked/resources'), 'win-x64');
  writeSidecar(path.join(here, 'dist', PUBLIC_ARTIFACTS.win.x64), manifest);
}

async function packageLinux() {
  // The AppImage arm64 runtime shipped by electron-builder 25 links the
  // unversioned libz.so (normally supplied only by zlib development packages).
  // Package on Linux, where patchelf can make the runtime depend on the
  // standard libz.so.1 before anyone downloads the standalone AppImage.
  if (process.platform !== 'linux')
    throw new Error('Linux AppImages must be packaged on Linux (the arm64 runtime needs patchelf)');
  const patchelf = spawnSync('patchelf', ['--version'], { encoding: 'utf8' });
  if (patchelf.status !== 0)
    throw new Error('Linux AppImage packaging requires patchelf (install it before packaging)');
  for (const arch of ['x64', 'arm64']) {
    const rid = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    const nodeStaging = await stageNode(rid);
    const { dir, manifest } = stageManifest('linux', arch, rid, nodeStaging);
    await electronBuild('linux', 'AppImage', arch, targetConfig('linux', nodeStaging, arch, dir));
    verifyPackagedResources(path.join(here, arch === 'arm64'
      ? 'dist/linux-arm64-unpacked/resources' : 'dist/linux-unpacked/resources'), rid);
    const appImage = path.join(here, 'dist', PUBLIC_ARTIFACTS.linux[arch]);
    const needed = spawnSync('patchelf', ['--print-needed', appImage], { encoding: 'utf8' });
    if (needed.status !== 0)
      throw new Error(`Cannot inspect ${appImage} ELF dependencies: ${needed.stderr || needed.error}`);
    if (needed.stdout.split(/\r?\n/).includes('libz.so')) {
      const patched = spawnSync('patchelf',
        ['--replace-needed', 'libz.so', 'libz.so.1', appImage], { encoding: 'utf8' });
      if (patched.status !== 0)
        throw new Error(`Cannot patch ${appImage} to use libz.so.1: ${patched.stderr || patched.error}`);
    }
    const verified = spawnSync('patchelf', ['--print-needed', appImage], { encoding: 'utf8' });
    if (verified.status !== 0 || !verified.stdout.split(/\r?\n/).includes('libz.so.1') ||
      verified.stdout.split(/\r?\n/).includes('libz.so'))
      throw new Error(`AppImage ${arch} must depend on runtime libz.so.1, not libz.so`);
    writeSidecar(appImage, manifest);
  }
}

const TARGET_BUILDERS = { mac: packageMac, win: packageWin, linux: packageLinux };

async function main() {
  const target = process.argv[2] ?? targetForPlatform();
  if (!TARGET_BUILDERS[target]) {
    console.error(`package: unknown target "${target ?? ''}" — expected mac, win or linux (default: the host OS)`);
    process.exit(1);
  }
  const failures = validateTarget(target);
  if (failures.length > 0) {
    console.error(`package: preflight failed for ${target}\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  await TARGET_BUILDERS[target]();
  fs.rmSync(path.join(here, 'dist', 'node-staging'), { recursive: true, force: true });
  fs.rmSync(path.join(here, 'dist', 'manifest-staging'), { recursive: true, force: true });
  console.log(`package: ${target} done`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
