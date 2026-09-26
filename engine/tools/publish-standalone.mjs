#!/usr/bin/env node
// Per-RID standalone server publish (T3.12/T6.12): for every server runtime
// id, publish both OpenRA.Server and its same-engine Ranked verifier as
// self-contained binaries under bin-standalone/<rid>/, then overlay what the
// server publish graph cannot see —
// OpenRA loads mod assemblies (OpenRA.Mods.*) and their dependencies
// (TagLibSharp) dynamically at runtime, so the framework-dependent bin/ output
// is copied over the publish output for parity with the dll-run — and the
// generated build.json so a packaged server advertises the same simBuild as
// the AppBundle it serves (package.mjs holds the two together, T3.13).
//
//   node tools/publish-standalone.mjs [rid …]     no args = all five
//   node tools/publish-standalone.mjs --rid osx-arm64
//
// Accepts a subset of rids (CI publishes one per runner); a rid that never
// finished shows up as a missing bin-standalone/<rid>/build.json at
// packaging time (T3.13 validation fails loudly).
// Called by release engineering only — packaging never builds (AGENTS.md rule 5).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStandaloneNativeRuntime } from '../steelseed-host/tools/native-runtime.mjs';

const ALL_RIDS = ['osx-arm64', 'osx-x64', 'win-x64', 'linux-x64', 'linux-arm64'];
const MOD_ASSEMBLIES = ['OpenRA.Mods.Common', 'OpenRA.Mods.Cnc', 'OpenRA.Mods.Steelseed'];

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(engineDir, 'bin');
const generatedDir = path.join(engineDir, 'steelseed-host/generated');
const standaloneDir = path.join(engineDir, 'bin-standalone');

function findDotnet() {
  const candidates = [
    process.env.DOTNET,
    path.join(process.env.HOME ?? '', '.dotnet/dotnet'),
    'dotnet',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
      if (probe.status === 0 || probe.error === undefined) return candidate;
    }
  }
  return null;
}

function fail(message) {
  console.error(`publish-standalone: ${message}`);
  process.exit(1);
}

// ---- arguments: a subset of rids, via positionals or --rid <rid> ----
const argv = process.argv.slice(2);
const requested = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--rid') {
    if (argv[i + 1] === undefined) fail('--rid needs a value');
    requested.push(argv[++i]);
  } else requested.push(argv[i]);
}
if (requested.length === 0) requested.push(...ALL_RIDS);
const unknown = requested.filter((rid) => !ALL_RIDS.includes(rid));
if (unknown.length > 0)
  fail(`unknown rid(s) ${unknown.join(', ')} — expected: ${ALL_RIDS.join(' ')}`);

// ---- preflight: the dynamic overlays must exist before any publish runs ----
const missing = [];
for (const name of MOD_ASSEMBLIES) {
  for (const suffix of ['.dll', '.deps.json'])
    if (!fs.existsSync(path.join(binDir, name + suffix))) missing.push(`bin/${name}${suffix}`);
}
if (!fs.existsSync(path.join(binDir, 'TagLibSharp.dll'))) missing.push('bin/TagLibSharp.dll');
if (!fs.existsSync(path.join(generatedDir, 'build.json'))) missing.push('generated/build.json');
if (missing.length > 0)
  fail(`dynamic overlays missing — build the framework-dependent output and the generated mod first:\n  ${missing.join('\n  ')}`);

const dotnet = findDotnet();
if (!dotnet) fail('dotnet not found — put it on PATH, at ~/.dotnet/dotnet, or set DOTNET');

for (const rid of requested) {
  const outDir = path.join(standaloneDir, rid);
  // dotnet publish does not remove stale native assets left by another RID.
  fs.rmSync(outDir, { recursive: true, force: true });
  const publish = spawnSync(
    dotnet,
    ['publish', 'OpenRA.Server/OpenRA.Server.csproj', '-c', 'Release', '-r', rid, `-p:TargetPlatform=${rid}`, '--self-contained', 'true', '-o', outDir, '-nologo'],
    { cwd: engineDir, stdio: 'inherit' },
  );
  if (publish.status !== 0)
    fail(`dotnet publish ${rid} failed (exit ${publish.status ?? publish.error?.code})`);

  for (const name of MOD_ASSEMBLIES) {
    for (const suffix of ['.dll', '.deps.json'])
      fs.copyFileSync(path.join(binDir, name + suffix), path.join(outDir, name + suffix));
  }
  fs.copyFileSync(path.join(binDir, 'TagLibSharp.dll'), path.join(outDir, 'TagLibSharp.dll'));
  fs.copyFileSync(path.join(generatedDir, 'build.json'), path.join(outDir, 'build.json'));

  // A standalone host must never custody Ranked replays without carrying the
  // exact-RID verifier. Every assembler/packager inherits this one output.
  const verifierPublish = spawnSync(process.execPath,
    [path.join(engineDir, 'steelseed-host/tools/publish-ranked-verifier.mjs'), '--rid', rid],
    { cwd: engineDir, stdio: 'inherit' });
  if (verifierPublish.status !== 0)
    fail(`ranked verifier publish ${rid} failed (exit ${verifierPublish.status ?? verifierPublish.error?.code})`);

  // Accept: the directory carries a runnable server (OpenRA.Server.exe on
  // Windows) plus build.json.
  const serverBinary = fs.existsSync(path.join(outDir, rid.startsWith('win') ? 'OpenRA.Server.exe' : 'OpenRA.Server'));
  if (!serverBinary) fail(`bin-standalone/${rid}: no server binary after publish`);
  const verifierBinary = path.join(outDir, 'ranked-replay-verifier', rid.startsWith('win') ? 'Steelseed.RankedReplayVerifier.exe' : 'Steelseed.RankedReplayVerifier');
  if (!fs.existsSync(verifierBinary)) fail(`bin-standalone/${rid}: no ranked verifier after publish`);
  assertStandaloneNativeRuntime(outDir, rid);
  console.log(`publish-standalone: bin-standalone/${rid} ready`);
}
