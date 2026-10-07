import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appBundleIdentityMetadata, assertDesktopAppBundleIdentity, contentDigest, desktopAppBundleDigest, DESKTOP_APP_BUNDLE_FILTER, DESKTOP_APP_BUNDLE_PROJECTION, MANIFEST_NAME, readEmbeddedManifest, releaseManifest as createReleaseManifest, sourceIdentity, writeManifest, writeSidecar } from './release-manifest.mjs';

const publicRoot = path.resolve(import.meta.dirname, '../../..');
const publicGit = args => args.includes('--show-toplevel') ? publicRoot : args.includes('--tags') ? 'v0.1.0' : args.includes('--porcelain') ? '' : 'a'.repeat(40);
const releaseManifest = options => createReleaseManifest({ sourceOptions: { root: publicRoot, readGit: publicGit }, ...options });

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-manifest-'));
	fs.mkdirSync(path.join(dir, 'pkg/sub'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'pkg/node_modules/ws'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'pkg/a.txt'), 'a');
	fs.writeFileSync(path.join(dir, 'pkg/sub/b.txt'), 'b');
	fs.writeFileSync(path.join(dir, 'pkg/node_modules/ws/index.js'), 'ws');
	return dir;
}

function zipFixture(dir, name) {
	assert.ok(['pkg.zip', 'bare.zip'].includes(name));
	const result = process.platform === 'win32'
		? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
			`Compress-Archive -LiteralPath pkg -DestinationPath '${name}'`], { cwd: dir })
		: spawnSync('zip', ['-rq', name, 'pkg'], { cwd: dir });
	assert.equal(result.status, 0, `fixture archive failed: ${result.error?.message ?? result.stderr?.toString()}`);
}

function bundleFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbundle-projection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { 'index.html': 'boot', 'steelseed/assets/game.js': 'game',
    'steelseed/assets/game.js.map': 'private sources', 'steelseed/top.map': 'map',
    '_framework/native.map': 'native map', 'other.map': 'other map' };
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  return dir;
}

test('desktop projection excludes only presentation maps and preserves the complete input', t => {
  const dir = bundleFixture(t), full = contentDigest(dir), projected = desktopAppBundleDigest(dir);
  assert.equal(full.files, 6); assert.equal(projected.files, 4);
  assert.deepEqual(DESKTOP_APP_BUNDLE_FILTER, ['**/*', '!steelseed/**/*.map']);
  // Copy precisely the same selection into a separate directory, outside the input tree.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'appbundle-shipped-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const rel of ['index.html', 'steelseed/assets/game.js', '_framework/native.map', 'other.map']) {
    fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
    fs.copyFileSync(path.join(dir, rel), path.join(copy, rel));
  }
  assert.deepEqual(contentDigest(copy), projected);
  fs.writeFileSync(path.join(dir, 'steelseed/assets/game.js.map'), 'different private sources');
  assert.notDeepEqual(contentDigest(dir), full);
  assert.deepEqual(desktopAppBundleDigest(dir), projected);
  for (const rel of ['steelseed/assets/game.js', '_framework/native.map', 'other.map']) {
    const file = path.join(dir, rel), before = fs.readFileSync(file);
    fs.writeFileSync(file, 'tampered runtime');
    assert.notDeepEqual(desktopAppBundleDigest(dir), projected, rel);
    fs.writeFileSync(file, before);
  }
});

test('desktop manifest has separate full input and exact shipped content identities', t => {
  const dir = bundleFixture(t);
  const manifest = releaseManifest({ artifact: 'desktop.exe', kind: 'desktop', contents: {
    appBundle: { dir, projection: DESKTOP_APP_BUNDLE_PROJECTION.policy } }, licenseTexts: [] });
  assert.deepEqual(manifest.inputs.appBundle, contentDigest(dir));
  assert.deepEqual(manifest.contents.appBundle, desktopAppBundleDigest(dir));
  assert.deepEqual(manifest.appBundleProjection, DESKTOP_APP_BUNDLE_PROJECTION);
  assertDesktopAppBundleIdentity(dir, manifest);
  const legacy = { contents: { appBundle: contentDigest(dir) } };
  assert.deepEqual(appBundleIdentityMetadata(legacy), {});
  assertDesktopAppBundleIdentity(dir, legacy);
  fs.appendFileSync(path.join(dir, 'steelseed/assets/game.js.map'), ' input tamper');
  assert.throws(() => assertDesktopAppBundleIdentity(dir, manifest), /Complete AppBundle input differs/);
});

test('projection metadata and source QA reject undeclared, malformed and changed identities', t => {
  const dir = bundleFixture(t);
  const valid = { inputs: { appBundle: contentDigest(dir) }, appBundleProjection: DESKTOP_APP_BUNDLE_PROJECTION,
    contents: { appBundle: desktopAppBundleDigest(dir) } };
  const copy = () => structuredClone(valid);
  for (const change of [v => delete v.inputs, v => delete v.appBundleProjection,
    v => v.appBundleProjection.policy = 'other', v => v.appBundleProjection.excluded.push('*.js'),
    v => v.inputs.appBundle.files = -1, v => v.inputs.appBundle.sha256 = 'bad',
    v => v.inputs.appBundle.extra = true, v => v.contents.appBundle.sha256 = '0'.repeat(64)]) {
    const value = copy(); change(value);
    assert.throws(() => assertDesktopAppBundleIdentity(dir, value));
  }
  for (const mutate of [() => fs.writeFileSync(path.join(dir, 'extra.js'), 'extra'),
    () => fs.rmSync(path.join(dir, 'index.html')), () => fs.writeFileSync(path.join(dir, 'other.map'), 'tampered')]) {
    mutate(); assert.throws(() => assertDesktopAppBundleIdentity(dir, valid));
  }
});

test('projection is an explicit desktop AppBundle policy, not an arbitrary skip list', t => {
  const dir = bundleFixture(t);
  for (const options of [
    { kind: 'node-zip', contents: { appBundle: { dir, projection: DESKTOP_APP_BUNDLE_PROJECTION.policy } } },
    { kind: 'desktop', contents: { node: { dir, projection: DESKTOP_APP_BUNDLE_PROJECTION.policy } } },
    { kind: 'desktop', contents: { appBundle: { dir, projection: 'unknown' } } },
    { kind: 'desktop', contents: { appBundle: { dir, projection: DESKTOP_APP_BUNDLE_PROJECTION.policy, skip: [] } } },
  ]) assert.throws(() => releaseManifest({ artifact: 'bad', licenseTexts: [], ...options }));
});

test('the contents digest covers every file but the manifest and the skipped paths', () => {
	const dir = fixture();
	try {
		const pkg = path.join(dir, 'pkg');
		const before = contentDigest(pkg);
		assert.equal(before.files, 3);
		const expected = createHash('sha256');
		for (const [rel, text] of [['a.txt', 'a'], ['node_modules/ws/index.js', 'ws'], ['sub/b.txt', 'b']])
			expected.update(`${rel}\t${createHash('sha256').update(text).digest('hex')}\n`);
		assert.equal(before.sha256, expected.digest('hex'));
		// The manifest itself never changes the digest it records.
		fs.writeFileSync(path.join(pkg, MANIFEST_NAME), '{}');
		assert.deepEqual(contentDigest(pkg), before);
		assert.equal(contentDigest(pkg, ['node_modules/']).files, 2);
		// Any content change does.
		fs.writeFileSync(path.join(pkg, 'sub/b.txt'), 'B');
		assert.notEqual(contentDigest(pkg).sha256, before.sha256);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('the manifest names this checkout, and the sidecar the finished artifact', () => {
	const commit = 'a'.repeat(40);
	const root = path.resolve(import.meta.dirname, '../../..');
	const readGit = args => args.includes('--show-toplevel') ? root : args.includes('--tags') ? 'v0.1.0' : args.includes('--porcelain') ? '' : commit;
	const sourceOptions = { root, readGit };
	const dir = fixture();
	try {
		const pkg = path.join(dir, 'pkg');
		const manifest = releaseManifest({
			artifact: 'pkg.zip', kind: 'node-zip', rid: 'linux-x64', sourceOptions,
			build: { simBuild: 'c947fe0886c6', modHash: 'f'.repeat(64) },
			contents: { node: { dir: pkg, skip: ['node_modules/'] } },
			licenseTexts: ['COPYING-GPLv3.txt'],
		});
		const source = sourceIdentity(sourceOptions);
		assert.deepEqual(manifest.source, source);
		if (fs.existsSync(path.join(import.meta.dirname, '../../../RELEASE-SOURCE.json'))) {
			// A public checkout: its own commit (and tag, when on one).
			assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);
			assert.equal(manifest.source.url, `https://github.com/jolynstudios/redlinewars/tree/${source.tag ?? source.commit}`);
		} else {
			// The official build: the public tag of this commit, and this commit as the source.
			assert.equal(manifest.source.commit, null);
			assert.match(manifest.source.sourceCommit, /^[0-9a-f]{40}$/);
			assert.match(manifest.source.tag, /^v\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/);
			assert.ok(manifest.source.tag.endsWith(manifest.source.sourceCommit.slice(0, 7)));
			assert.equal(manifest.source.url, `https://github.com/jolynstudios/redlinewars/tree/${manifest.source.tag}`);
		}
		assert.equal(manifest.license, 'GPL-3.0-or-later');
		assert.equal(manifest.contents.node.files, 2);
		assert.deepEqual(manifest.contents.node.skipped, ['node_modules/']);
		writeManifest(pkg, manifest);
		zipFixture(dir, 'pkg.zip');
		const artifact = path.join(dir, 'pkg.zip');
		assert.deepEqual(readEmbeddedManifest(artifact), manifest);
		const sidecar = JSON.parse(fs.readFileSync(writeSidecar(artifact, manifest), 'utf8'));
		assert.equal(sidecar.artifactSha256, createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'));
		assert.equal(sidecar.artifactBytes, fs.statSync(artifact).size);
		// An artifact without a manifest has none to report.
		fs.rmSync(path.join(pkg, MANIFEST_NAME));
		zipFixture(dir, 'bare.zip');
		assert.equal(readEmbeddedManifest(path.join(dir, 'bare.zip')), null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('public identity refuses an enclosing repository and ignores private provenance overrides', () => {
  assert.throws(() => sourceIdentity({ root: publicRoot, readGit: () => path.dirname(publicRoot) }), /own git checkout/);
  const identity = sourceIdentity({ root: publicRoot, readGit: publicGit, env: { REDLINE_PRIVATE_SOURCE_SELECTION: '/private/selection.json' } });
  assert.equal(identity.commit, 'a'.repeat(40));
  assert.equal(identity.tag, 'v0.1.0');
  assert.equal(identity.sourceCommit, undefined);
  assert.equal(identity.sourceSelection, undefined);
});
