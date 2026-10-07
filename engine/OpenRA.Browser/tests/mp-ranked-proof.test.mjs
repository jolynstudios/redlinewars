import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rankedOutputOptions, publishedRankedRuntime, pinsFromRankedProof } from './mp-ranked-proof.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ranked-proof-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const build = { schema: 1, simBuild: '123456789abc', modHash: 'a'.repeat(64) };
const mapUid = 'b'.repeat(40), rulesHash = 'c'.repeat(64), replaySha256 = 'd'.repeat(64);
const proof = () => ({ build, modVersion: `engine-assetless-${build.simBuild}`, mapUid, matchId: 'fresh-match', replaySha256,
  inspection: { MapUid: mapUid, Version: `engine-assetless-${build.simBuild}`, RulesHash: rulesHash },
  receipt: { matchId: 'fresh-match', replaySha256, simBuild: build.simBuild, mapUid, rulesHash,
    status: 'settled', terminationReason: 'surrender' },
  native: { Status: 'settled', TerminationReason: 'surrender', FinalTick: 100 } });

test('default gate retains canonical tracked pins, explicit artifact output never changes that destination', t => {
  const repoRoot = fixture(t);
  assert.deepEqual(rankedOutputOptions([], { repoRoot }), { outputDir: null, pinsFile: path.join(repoRoot, 'deploy/vps/ranked-pins.json') });
  const result = rankedOutputOptions(['--out-dir', '.artifacts/fresh-ranked'], { repoRoot, cwd: repoRoot });
  assert.equal(result.pinsFile, path.join(repoRoot, '.artifacts/fresh-ranked/ranked-pins.json'));
  assert.equal(fs.existsSync(result.outputDir), false);
});
test('existing evidence and symlink output parents cannot recycle acceptance or escape artifacts', t => {
  const repoRoot = fixture(t), existing = path.join(repoRoot, '.artifacts/previous');
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, 'report.json'), '{"status":"passed"}');
  assert.throws(() => rankedOutputOptions(['--out-dir', existing], { repoRoot }), /fresh/);
  const other = fixture(t);
  fs.symlinkSync(other, path.join(repoRoot, '.artifacts/redirect'), 'dir');
  assert.throws(() => rankedOutputOptions(['--out-dir', path.join(repoRoot, '.artifacts/redirect/new')], { repoRoot }), /symlinks/);
});
test('output parser rejects receipt input, unknown flags, missing path and writes into product source', t => {
  const repoRoot = fixture(t);
  for (const argv of [['--out-dir'], ['--receipt', 'old.json'], ['--out-dir', '--input'],
    ['--out-dir', '.artifacts/new', '--force'], ['--out-dir', 'engine/bin-browser/new'],
    ['--out-dir', '.artifacts'], ['--out-dir', '.artifacts/../desktop/new']])
    assert.throws(() => rankedOutputOptions(argv, { repoRoot, cwd: repoRoot }));
});
function stageRuntime(engineRoot, rid) {
  const dir = path.join(engineRoot, 'bin-standalone', rid);
  fs.mkdirSync(path.join(dir, 'ranked-replay-verifier'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify(build));
  const suffix = rid.startsWith('win') ? '.exe' : '';
  fs.writeFileSync(path.join(dir, 'OpenRA.Server' + suffix), 'test file; not a real engine');
  fs.writeFileSync(path.join(dir, 'ranked-replay-verifier/Steelseed.RankedReplayVerifier' + suffix), 'test file; not a real engine');
  return dir;
}
test('verifier uses the one canonical published native RID, never the obsolete openra/bin path', t => {
  const engineRoot = fixture(t), dir = stageRuntime(engineRoot, 'osx-arm64');
  const result = publishedRankedRuntime(engineRoot, build, 'darwin', 'arm64');
  assert.equal(result.verifier, path.join(dir, 'ranked-replay-verifier/Steelseed.RankedReplayVerifier'));
  assert.equal(result.server, path.join(dir, 'OpenRA.Server'));
  assert.throws(() => publishedRankedRuntime(engineRoot, { ...build, simBuild: '000000000000' }, 'darwin', 'arm64'), /simBuild/);
  assert.throws(() => publishedRankedRuntime(engineRoot, { ...build, modHash: 'e'.repeat(64) }, 'darwin', 'arm64'), /modHash/);
});
test('Windows on ARM uses existing win-x64 canonical publisher output', t => {
  const engineRoot = fixture(t), dir = stageRuntime(engineRoot, 'win-x64');
  assert.equal(publishedRankedRuntime(engineRoot, build, 'win32', 'arm64').verifier,
    path.join(dir, 'ranked-replay-verifier/Steelseed.RankedReplayVerifier.exe'));
});
test('missing publisher runtime or verifier fails without alternate build/fallback', t => {
  const engineRoot = fixture(t);
  assert.throws(() => publishedRankedRuntime(engineRoot, build, 'linux', 'x64'));
  const dir = stageRuntime(engineRoot, 'linux-x64');
  fs.rmSync(path.join(dir, 'ranked-replay-verifier/Steelseed.RankedReplayVerifier'));
  assert.throws(() => publishedRankedRuntime(engineRoot, build, 'linux', 'x64'));
  assert.throws(() => publishedRankedRuntime(engineRoot, build, 'unknown', 'x64'), /runtime id/);
});
test('pure proof contract produces exactly the legitimate release pin schema', () => {
  assert.deepEqual(pinsFromRankedProof(proof()), { schema: 1, simBuild: build.simBuild, mapUid, rulesHash });
});
for (const [label, mutate] of [
  ['prior match receipt', p => p.receipt.matchId = 'previous-match'],
  ['prior replay receipt', p => p.receipt.replaySha256 = 'e'.repeat(64)],
  ['old sim receipt', p => p.receipt.simBuild = 'abcdef123456'],
  ['old replay engine', p => p.inspection.Version = 'abcdef123456'],
  ['old generated mod', p => p.modVersion = 'engine-assetless-abcdef123456'],
  ['wrong map inspection', p => p.inspection.MapUid = 'e'.repeat(40)],
  ['wrong rules receipt', p => p.receipt.rulesHash = 'e'.repeat(64)],
  ['void worker receipt', p => p.receipt.status = 'void'],
  ['void native receipt', p => p.native.Status = 'void'],
  ['no native progress', p => p.native.FinalTick = 0],
  ['non-surrender result', p => p.native.TerminationReason = 'incomplete'],
]) test(`pins reject ${label}`, () => {
  const input = proof(); mutate(input);
  assert.throws(() => pinsFromRankedProof(input));
});
