import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';

import { appBundleAudioAssets, PUBLIC_ARTIFACTS, targetConfig } from './package.mjs';
import { LEGAL_DOCS } from './shell-options.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('desktop package carries every imported shell module', () => {
	const config = targetConfig('linux', '/tmp/redline-node-fixture');
	for (const file of ['main.mjs', 'settings.mjs', 'update-gate.mjs', 'preload.cjs', 'account-broker.mjs', 'donate-hosting.mjs', 'shell-options.mjs', 'build/icon.png'])
		assert.ok(config.files.includes(file), `${file} is missing from the Electron package`);
	// Every relative import of main.mjs (and of what it imports) must ship.
	const shipped = new Set(config.files);
	const seen = new Set();
	const walk = file => {
		if (seen.has(file)) return;
		seen.add(file);
		assert.ok(shipped.has(file), `${file} is imported by the shell but not packaged`);
		const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
		for (const [, rel] of source.matchAll(/^import[^'"]*['"](\.\/[^'"]+)['"]/gm)) walk(path.normalize(rel));
	};
	walk('main.mjs');
});

test('every installer ships the licence texts under resources/legal', () => {
	for (const target of ['mac', 'win', 'linux']) {
		const config = targetConfig(target, '/tmp/redline-node-fixture');
		const legal = config.extraResources.filter(resource => resource.to.startsWith('legal/'));
		const source = to => legal.find(resource => resource.to === to)?.from;
		// The GPL engine's own texts, the app's licence and the notices, by name.
		assert.equal(source('legal/COPYING-GPLv3.txt'), path.join(repoRoot, 'engine', 'COPYING'));
		assert.equal(source('legal/AUTHORS-OpenRA.txt'), path.join(repoRoot, 'engine', 'AUTHORS'));
		assert.equal(source('legal/LICENSE.txt'), path.join(repoRoot, 'LICENSE'));
		assert.equal(source('legal/THIRD_PARTY_NOTICES.md'), path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'));
		// Every OFL text beside the website's fonts ships beside the app's too.
		const licenses = path.join(repoRoot, 'web', 'public', 'licenses');
		const ofl = fs.readdirSync(licenses).filter(file => /OFL/.test(file));
		assert.ok(ofl.length >= 2, 'the Archivo and Martian Mono OFL texts are missing from web/public/licenses');
		for (const file of ofl) assert.equal(source(`legal/fonts/${file}`), path.join(licenses, file), `${file} is not packaged`);
		// What ships is exactly what the shell's licence viewer may read.
		assert.deepEqual(legal.map(resource => resource.to).sort(), Object.values(LEGAL_DOCS).map(file => `legal/${file}`).sort());
		for (const resource of legal) assert.ok(fs.existsSync(resource.from), `${resource.from} does not exist in the repo`);
		assert.match(config.copyright, /Jolyn Studios · Engine: OpenRA \(GPLv3\)/);
	}
	// The desktop app is free software under the repository's licence; the package names it by its
	// SPDX id instead of pointing at a file outside the package.
	const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8'));
	assert.equal(pkg.license, 'GPL-3.0-or-later');
	assert.equal(LEGAL_DOCS.license, 'LICENSE.txt');
});

test('every installer carries the release manifest', () => {
	for (const target of ['mac', 'win', 'linux']) {
		const config = targetConfig(target, '/tmp/redline-node-fixture', 'x64', '/tmp/redline-manifest-fixture');
		const manifest = config.extraResources.filter(resource => resource.to === 'RELEASE-MANIFEST.json');
		assert.deepEqual(manifest.map(resource => resource.from), [path.join('/tmp/redline-manifest-fixture', 'RELEASE-MANIFEST.json')]);
	}
});

test('the shell fonts carry their OFL texts', () => {
	// shell/** ships inside the app: the licence travels with each face.
	const licenses = path.join(repoRoot, 'web', 'public', 'licenses');
	for (const file of fs.readdirSync(licenses).filter(name => /OFL/.test(name))) {
		const copy = path.join(import.meta.dirname, 'shell', 'fonts', file);
		assert.ok(fs.existsSync(copy), `shell/fonts/${file} is missing`);
		assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(licenses, file), 'utf8'), `shell/fonts/${file} drifted from web/public/licenses`);
	}
});

test('desktop stays glue: game and node arrive only as shared extra resources', () => {
	const config = targetConfig('win', '/tmp/redline-node-fixture');
	assert.ok(config.extraResources.some(resource => resource.to === 'AppBundle'));
	assert.ok(config.extraResources.some(resource => resource.to === 'steelseed-node'));
	assert.equal(config.files.some(file => /game|engine|AppBundle/i.test(file)), false);
});

test('the staged node npm modules ship through their own filtered entries', () => {
	const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'steelseed-node-staging-'));
	fs.mkdirSync(path.join(staging, 'node_modules', 'ws', 'lib'), { recursive: true });
	fs.writeFileSync(path.join(staging, 'node_modules', 'ws', 'index.js'), '');
	fs.writeFileSync(path.join(staging, 'server.mjs'), '');
	try {
		const config = targetConfig('win', staging);
		// electron-builder 26 resolves a directory named node_modules through the
		// project's own dependency graph (desktop/package.json declares none) and
		// silently drops it — nodeparitygate caught `ws` missing from every desktop
		// artifact. The root entry must opt out, and each module must arrive as its
		// own unfiltered copy.
		const root = config.extraResources.find(resource => resource.to === 'steelseed-node');
		assert.ok(root, 'the staged node still ships as one steelseed-node resource');
		assert.ok(root.filter.includes('!node_modules'),
			'the root entry must exclude node_modules from dependency-graph resolution');
		const moduleEntry = config.extraResources.find(resource => resource.to === 'steelseed-node/node_modules/ws');
		assert.ok(moduleEntry, 'each staged npm module gets its own extraResources entry');
		assert.equal(moduleEntry.from, path.join(staging, 'node_modules', 'ws'));
		assert.deepEqual(moduleEntry.filter, ['**/*']);
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
});

test('packaged AppBundle carries both shared audio formats', t => {
	const config = targetConfig('linux', '/tmp/redline-node-fixture');
	assert.ok(config.extraResources.find(resource => resource.to === 'AppBundle')?.from.endsWith(path.join('engine', 'bin-browser', 'AppBundle')));
	const audio = appBundleAudioAssets();
	if (audio.length === 0) return t.skip('shared AppBundle is intentionally absent from GPU-free CI');
	assert.ok(audio.some(file => file.endsWith('.m4a')), 'AppBundle has no m4a audio');
	assert.ok(audio.some(file => file.endsWith('.mp3')), 'AppBundle has no mp3 audio');
});

test('one packager emits the exact public desktop download names', () => {
	assert.equal(targetConfig('win', '/tmp/redline-node-fixture', 'x64').win.artifactName,
		PUBLIC_ARTIFACTS.win.x64);
	assert.equal(targetConfig('linux', '/tmp/redline-node-fixture', 'x64').linux.artifactName,
		PUBLIC_ARTIFACTS.linux.x64);
	assert.equal(targetConfig('linux', '/tmp/redline-node-fixture', 'arm64').linux.artifactName,
		PUBLIC_ARTIFACTS.linux.arm64);

	const repoRoot = path.resolve(import.meta.dirname, '..');
	const packager = fs.readFileSync(path.join(repoRoot, 'desktop/package.mjs'), 'utf8');
	// The website and the download publisher are private: a public checkout checks the packager alone.
	const read = rel => fs.existsSync(path.join(repoRoot, rel)) ? fs.readFileSync(path.join(repoRoot, rel), 'utf8') : null;
	const landing = read('landing/download.html'), publisher = read('deploy/vps/publish-downloads.sh');
	for (const artifact of Object.values(PUBLIC_ARTIFACTS).flatMap(Object.values)) {
		const name = new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		if (landing !== null) assert.match(landing, name, `${artifact} is absent from the landing download page`);
		if (publisher !== null) assert.match(publisher, name, `${artifact} is absent from the release publisher`);
	}
	assert.match(packager, /spawnSync\('ditto', \['-c', '-k', '--sequesterRsrc', '--keepParent'/,
		'mac public artifacts must archive the final signed app bundle');
});
