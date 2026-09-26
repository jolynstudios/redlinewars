import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { contentDigest, MANIFEST_NAME, publicTagFor, readEmbeddedManifest, releaseManifest, sourceIdentity, writeManifest, writeSidecar } from './release-manifest.mjs';

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-manifest-'));
	fs.mkdirSync(path.join(dir, 'pkg/sub'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'pkg/node_modules/ws'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'pkg/a.txt'), 'a');
	fs.writeFileSync(path.join(dir, 'pkg/sub/b.txt'), 'b');
	fs.writeFileSync(path.join(dir, 'pkg/node_modules/ws/index.js'), 'ws');
	return dir;
}

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

test('a private commit has one public tag: its commit date and short hash', () => {
	assert.equal(publicTagFor('666edbe66466859200090d4f9f3d3cc33c55b8ee', '2026.09.26'), 'v2026.09.26-666edbe');
	assert.throws(() => publicTagFor('666edbe', '2026.09.26'), /no public tag/);
	assert.throws(() => publicTagFor('666edbe66466859200090d4f9f3d3cc33c55b8ee', '26-09-2026'), /no public tag/);
});

test('the manifest names this checkout, and the sidecar the finished artifact', () => {
	const dir = fixture();
	try {
		const pkg = path.join(dir, 'pkg');
		const manifest = releaseManifest({
			artifact: 'pkg.zip', kind: 'node-zip', rid: 'linux-x64',
			build: { simBuild: 'c947fe0886c6', modHash: 'f'.repeat(64) },
			contents: { node: { dir: pkg, skip: ['node_modules/'] } },
			licenseTexts: ['COPYING-GPLv3.txt'],
		});
		const source = sourceIdentity();
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
		const zip = spawnSync('zip', ['-rq', 'pkg.zip', 'pkg'], { cwd: dir });
		assert.equal(zip.status, 0, 'zip is needed for this test');
		const artifact = path.join(dir, 'pkg.zip');
		assert.deepEqual(readEmbeddedManifest(artifact), manifest);
		const sidecar = JSON.parse(fs.readFileSync(writeSidecar(artifact, manifest), 'utf8'));
		assert.equal(sidecar.artifactSha256, createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'));
		assert.equal(sidecar.artifactBytes, fs.statSync(artifact).size);
		// An artifact without a manifest has none to report.
		fs.rmSync(path.join(pkg, MANIFEST_NAME));
		spawnSync('zip', ['-rq', 'bare.zip', 'pkg'], { cwd: dir });
		assert.equal(readEmbeddedManifest(path.join(dir, 'bare.zip')), null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
