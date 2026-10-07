import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appBundleVersionProblems, parsePackageOptions, SHELL_FILES, shellSourceProblems, targetConfig, validateTarget } from './package.mjs';

const root = path.resolve(import.meta.dirname, '..');
test('all desktop targets package the one existing shared AppBundle and canonical node', () => {
  for (const target of ['mac', 'win', 'linux']) {
    const config = targetConfig(target, '/tmp/staged-node');
    assert.equal(config.extraResources.find(r => r.to === 'AppBundle').from, path.join(root, 'engine/bin-browser/AppBundle'));
    assert.equal(config.extraResources.find(r => r.to === 'steelseed-node').from, '/tmp/staged-node');
    assert.deepEqual(config.files, [...SHELL_FILES]);
    assert.ok(!config.mac?.extendInfo?.NSMicrophoneUsageDescription);
    assert.ok(!config.mac?.extendInfo?.NSCameraUsageDescription);
    for (const item of config.extraResources.filter(r => r.to.startsWith('legal/'))) assert.ok(fs.existsSync(item.from));
  }
  assert.deepEqual(shellSourceProblems(), []);
});

test('the package preflight detects a missing or broken imported shell module', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-shell-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of SHELL_FILES) fs.copyFileSync(path.join(import.meta.dirname, file), path.join(dir, file));
  assert.deepEqual(shellSourceProblems(dir), []);
  fs.writeFileSync(path.join(dir, 'server-ready.mjs'), 'export function invalid( {');
  assert.ok(shellSourceProblems(dir).some(p => p.startsWith('server-ready.mjs: does not parse')));
  fs.rmSync(path.join(dir, 'main.mjs'));
  assert.ok(shellSourceProblems(dir).some(p => p.startsWith('main.mjs: missing')));
});

test('packaging rejects different game versions without rebuilding', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-version-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const build = path.join(dir, 'build.json'), pkg = path.join(dir, 'package.json');
  fs.writeFileSync(build, JSON.stringify({ app: '0.1.0' }));
  fs.writeFileSync(pkg, JSON.stringify({ version: '0.1.0' }));
  assert.deepEqual(appBundleVersionProblems(build, pkg), []);
  fs.writeFileSync(build, JSON.stringify({ app: '0.2.0' }));
  assert.match(appBundleVersionProblems(build, pkg)[0], /0\.2\.0 != desktop version 0\.1\.0/);
  assert.throws(() => parsePackageOptions(['--output-dir']), /requires a path/);
});
