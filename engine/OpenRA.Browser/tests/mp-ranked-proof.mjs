// Output/path contracts for the existing real Ranked E2E gate. No simulation
// or receipt input lane: each invocation must earn its evidence from two matches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRid } from '../../steelseed-host/tools/dedicated-runner.mjs';

export function rankedOutputOptions(argv, { repoRoot, cwd = process.cwd() }) {
  if (argv.length === 0) return { outputDir: null, pinsFile: path.join(repoRoot, 'deploy/vps/ranked-pins.json') };
  assert.equal(argv.length, 2, 'Usage: mp-ranked-e2e.mjs [--out-dir NEW_ARTIFACT_DIRECTORY]');
  assert.equal(argv[0], '--out-dir');
  assert.ok(argv[1] && !argv[1].startsWith('--'), '--out-dir requires a path');
  const outputDir = path.resolve(cwd, argv[1]);
  const artifacts = path.join(repoRoot, '.artifacts');
  assert.ok(outputDir.startsWith(artifacts + path.sep), 'Ranked evidence must be under this checkout .artifacts');
  assert.ok(!fs.existsSync(outputDir), 'Ranked evidence directory must be fresh; never reuse prior acceptance');
  // Do not allow a symlink to redirect evidence writes into product inputs.
  const canonicalRoot = fs.realpathSync(repoRoot);
  for (let parent = path.dirname(outputDir); parent.startsWith(repoRoot); parent = path.dirname(parent)) {
    if (fs.existsSync(parent)) assert.equal(fs.realpathSync(parent), path.join(canonicalRoot, path.relative(repoRoot, parent)), 'Ranked output parents must not be symlinks');
    if (parent === repoRoot) break;
  }
  return { outputDir, pinsFile: path.join(outputDir, 'ranked-pins.json') };
}

export function publishedRankedRuntime(engineRoot, build, platform = process.platform, arch = process.arch) {
  const rid = resolveRid(platform, arch);
  const runtimeDir = path.join(engineRoot, 'bin-standalone', rid);
  const runtimeBuild = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'build.json'), 'utf8'));
  for (const key of ['simBuild', 'modHash']) assert.equal(runtimeBuild[key], build[key], `Published native ${key} differs from the shared build`);
  const suffix = rid.startsWith('win') ? '.exe' : '';
  const server = path.join(runtimeDir, `OpenRA.Server${suffix}`);
  const verifier = path.join(runtimeDir, 'ranked-replay-verifier', `Steelseed.RankedReplayVerifier${suffix}`);
  for (const file of [server, verifier]) assert.ok(fs.statSync(file).isFile(), `Missing published runtime: ${file}`);
  return { rid, runtimeDir, server, verifier };
}

export function pinsFromRankedProof({ build, modVersion, mapUid, inspection, matchId, receipt, native, replaySha256 }) {
  assert.match(build.simBuild, /^[0-9a-f]{12}$/);
  assert.match(mapUid, /^[0-9a-f]{40}$/);
  assert.match(inspection.RulesHash, /^[0-9a-f]{64}$/);
  assert.equal(inspection.MapUid, mapUid);
  assert.ok(typeof modVersion === 'string' && (modVersion === build.simBuild || modVersion.endsWith(`-${build.simBuild}`)), 'Generated mod version must identify this engine build');
  assert.equal(inspection.Version, modVersion, 'Inspected replay comes from another engine/mod build');
  assert.match(replaySha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.matchId, matchId, 'Receipt belongs to another match');
  assert.equal(receipt.replaySha256, replaySha256, 'Receipt belongs to another replay');
  assert.equal(receipt.simBuild, build.simBuild);
  assert.equal(receipt.mapUid, mapUid);
  assert.equal(receipt.rulesHash, inspection.RulesHash);
  assert.equal(receipt.status, 'settled');
  assert.equal(receipt.terminationReason, 'surrender');
  assert.equal(native.Status, 'settled');
  assert.equal(native.TerminationReason, 'surrender');
  assert.ok(Number.isSafeInteger(native.FinalTick) && native.FinalTick > 0);
  return { schema: 1, simBuild: build.simBuild, mapUid, rulesHash: inspection.RulesHash };
}
