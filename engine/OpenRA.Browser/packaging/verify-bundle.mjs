// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);

function value(name) {
	const index = args.indexOf(name);
	if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--'))
		throw new Error(`Missing required ${name} argument.`);

	return args[index + 1];
}

function optionalValue(name, fallback = '') {
	const index = args.indexOf(name);
	return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function git(repoRoot, ...gitArgs) {
	return execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function sourceRepositoryUrl(value) {
	const normalized = value.trim().replace(/\.git$/, '').replace(/\/$/, '');
	if (normalized.length === 0)
		return null;

	if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized))
		throw new Error('The source repository must be a public https://github.com/OWNER/REPOSITORY URL; ' +
			'use explicit commit and archive URLs for another host.');

	return normalized;
}

function publicSourceUrl(value, name) {
	if (value.trim().length === 0)
		return null;

	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid public HTTPS URL.`);
	}
	if (url.protocol !== 'https:' || url.username || url.password)
		throw new Error(`${name} must be a public HTTPS URL without credentials.`);

	return url.toString();
}

/**
 * Westwood/EA binary content containers. Forbidden ANYWHERE in the physical bundle or the
 * embedded VFS, by extension rather than by filename.
 *
 * This replaced a denylist derived from `mods/ra-content/installer/downloads.yaml` on
 * 2026-07-30. That manifest listed the filenames EA ships, and the verifier proved none of them
 * were bundled. It was the right idea with the wrong authority: the ra-content mod has since
 * been deleted entirely — `engine/mods/` holds only `steelseed` — so the denylist source
 * vanished and `make browser` could no longer complete. See `issues/engine-1.md`.
 *
 * Extensions are strictly broader than names. A manifest can only forbid what someone
 * remembered to list; an extension forbids the whole format, including a file renamed to evade
 * a name check. Rule 13a already prohibits `.mix`/`.shp`/`.aud`/`.vqa` loaders, so this makes
 * the packaging check agree with the rule the project already holds.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH, and it matters: the mod's FUNCTIONAL data. HP, cost,
 * range, damage, reload and turret rates, speed, vision and tech-tree shape live in
 * `mods/steelseed/rules/*.yaml` and `weapons/weapons.yaml` — 1,713 lines of it. That is game
 * balance, not content: it ships inside the GPLv3 fork rather than in any EA download, and
 * without it the simulation would be balanced by guesswork. `.yaml` is not on this list and
 * must never be added to it. Stripping those files would not improve compliance; it would
 * delete the game's dynamics.
 */
const FORBIDDEN_CONTENT_EXTENSIONS = new Set(['.mix', '.shp', '.aud', '.vqa', '.wsa']);

function forbiddenArtifactPath(value) {
	const normalized = value.replaceAll('\\', '/').toLowerCase();
	const components = normalized.split('/').filter(Boolean);
	const basename = components.at(-1) ?? '';
	const dot = basename.lastIndexOf('.');
	const extension = dot > 0 ? basename.slice(dot) : '';
	return components.includes('devcontent') || FORBIDDEN_CONTENT_EXTENSIONS.has(extension);
}

function scanVfs(node, parent = 'resources.vfs', violations = []) {
	if (node == null || typeof node !== 'object')
		return violations;

	for (const [key, value] of Object.entries(node)) {
		const location = `${parent}.${key}`;
		if (forbiddenArtifactPath(key))
			violations.push(`${location} maps forbidden game content`);
		scanVfs(value, location, violations);
	}

	return violations;
}

async function scanBundle(root) {
	const violations = [];
	const pending = [root];

	while (pending.length > 0) {
		const directory = pending.pop();
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name);
			const relative = path.relative(root, fullPath) || '.';
			if (entry.name.toLowerCase() === 'devcontent')
				violations.push(`${relative} is a forbidden devcontent artifact path`);

			if (entry.isSymbolicLink()) {
				violations.push(`${relative} is a forbidden artifact symlink`);
				continue;
			}

			if (entry.isDirectory()) {
				pending.push(fullPath);
				continue;
			}

			if (entry.isFile() && forbiddenArtifactPath(entry.name))
				violations.push(`${relative} is installed game content`);
		}
	}

	return violations.sort();
}

const NoticedRuntimePackages = new Set([
	'DiscordRichPresence/1.2.1.24',
	'Linguini.Bundle/0.8.1',
	'Linguini.Shared/0.8.0',
	'Linguini.Syntax/0.8.0',
	'MP3Sharp/1.0.5',
	'Mono.Nat/3.0.4',
	'NVorbis/0.10.5',
	'Newtonsoft.Json/13.0.1',
	'OpenRA-Eluant/1.0.22',
	'OpenRA-FuzzyLogicLibrary/1.0.1',
	'Pfim/0.11.3',
	'SharpZipLib/1.4.2',
	'StbTrueTypeSharp/1.26.12',
	'TagLibSharp/2.3.0',
	'rix0rrr.BeaconLib/1.0.2'
]);

function isMicrosoftRuntimePackage(packageId) {
	return /^(Microsoft\.|System\.|runtime\.any\.System\.)/.test(packageId);
}

async function verifyRuntimePackageNotices(repoRoot, assemblyResources) {
	const assetsPath = path.join(repoRoot, 'OpenRA.Browser', 'obj', 'project.assets.json');
	const assets = JSON.parse(await fs.readFile(assetsPath, 'utf8'));
	const notices = await fs.readFile(
		path.join(repoRoot, 'OpenRA.Browser', 'packaging', 'THIRD-PARTY-NOTICES.txt'), 'utf8');
	const assemblies = new Set(Object.keys(assemblyResources).map(name => name.replace(/\.wasm$/, '.dll')));
	const shipped = new Set();

	for (const [packageId, metadata] of Object.entries(assets.libraries ?? {})) {
		if (metadata.type !== 'package')
			continue;

		const containsRuntimeAssembly = (metadata.files ?? [])
			.some(file => file.endsWith('.dll') && assemblies.has(path.posix.basename(file)));
		if (containsRuntimeAssembly && !isMicrosoftRuntimePackage(packageId))
			shipped.add(packageId);
	}

	const missing = [...shipped].filter(packageId => !NoticedRuntimePackages.has(packageId)).sort();
	const stale = [...NoticedRuntimePackages].filter(packageId => !shipped.has(packageId)).sort();
	if (missing.length > 0 || stale.length > 0)
		throw new Error('Runtime-package notice inventory is out of date:' +
			`${missing.length > 0 ? `\n- missing: ${missing.join(', ')}` : ''}` +
			`${stale.length > 0 ? `\n- not shipped: ${stale.join(', ')}` : ''}`);

	const absentFromNotice = [...NoticedRuntimePackages]
		.filter(packageId => !notices.includes(packageId.replace('/', ' ')))
		.sort();
	if (absentFromNotice.length > 0)
		throw new Error(`Runtime packages absent from THIRD-PARTY-NOTICES.txt: ${absentFromNotice.join(', ')}`);

	return shipped.size;
}

async function dotnetThirdPartyNotices(bundle) {
	const runtimeConfig = JSON.parse(await fs.readFile(
		path.join(bundle, 'OpenRA.Browser.runtimeconfig.json'), 'utf8'));
	const runtimeVersion = runtimeConfig.runtimeOptions?.includedFrameworks
		?.find(framework => framework.name === 'Microsoft.NETCore.App')?.version;
	if (!runtimeVersion)
		throw new Error('Could not determine the bundled Microsoft.NETCore.App version.');

	const roots = [process.env.DOTNET_ROOT, path.join(os.homedir(), '.dotnet'), '/usr/local/share/dotnet']
		.filter(Boolean);
	for (const root of roots) {
		const notice = path.join(root, 'packs', 'Microsoft.NETCore.App.Runtime.Mono.browser-wasm',
			runtimeVersion, 'THIRD-PARTY-NOTICES.TXT');
		try {
			await fs.access(notice);
			return notice;
		} catch {
			// Continue to the next possible .NET root.
		}
	}

	throw new Error(`Could not locate the .NET browser-wasm ${runtimeVersion} runtime third-party notices.`);
}

const repoRoot = path.resolve(value('--repo-root'));
const bundle = path.resolve(value('--bundle'));
const repository = sourceRepositoryUrl(optionalValue('--source-repository'));
const explicitCommitUrl = publicSourceUrl(optionalValue('--source-commit-url'), 'The source commit URL');
const explicitArchiveUrl = publicSourceUrl(optionalValue('--source-archive-url'), 'The source archive URL');
const requirePublicSource = optionalValue('--require-public-source', '0') === '1';
const packaging = path.join(repoRoot, 'OpenRA.Browser', 'packaging');

if ((explicitCommitUrl == null) !== (explicitArchiveUrl == null))
	throw new Error('Explicit corresponding source requires both commit and archive URLs.');

if (repository != null && explicitCommitUrl != null)
	throw new Error('Use either a GitHub source repository or explicit commit/archive URLs, not both.');

const violations = await scanBundle(bundle);
const bootPath = path.join(bundle, '_framework', 'blazor.boot.json');
const boot = JSON.parse(await fs.readFile(bootPath, 'utf8'));
violations.push(...scanVfs(boot.resources?.vfs));

if (violations.length > 0)
	throw new Error(`Browser artifact contains non-distributable content:\n- ${violations.join('\n- ')}`);

const noticedPackages = await verifyRuntimePackageNotices(repoRoot, boot.resources?.assembly ?? {});

const commit = git(repoRoot, 'rev-parse', 'HEAD');
const dirty = git(repoRoot, 'status', '--porcelain').length > 0;
if (requirePublicSource && repository == null && explicitCommitUrl == null)
	throw new Error('A distributable browser build requires BROWSER_SOURCE_REPOSITORY_URL or explicit ' +
		'BROWSER_SOURCE_COMMIT_URL and BROWSER_SOURCE_ARCHIVE_URL values.');

if (requirePublicSource && dirty)
	throw new Error('A distributable browser build requires a clean working tree.');

let upstream = 'not configured';
try {
	upstream = git(repoRoot, 'remote', 'get-url', 'upstream');
} catch {
	// A downstream checkout is not required to retain the upstream remote.
}

const sourceLocation = repository == null && explicitCommitUrl == null
	? `Repository: local checkout (no public corresponding-source URL configured)\n` +
		`Upstream project: ${upstream}\n` +
		`Commit: ${commit}\n` +
		`Commit link: unavailable for this local build\n` +
		`To produce a distributable artifact, run:\n` +
		`  make BROWSER_SOURCE_REPOSITORY_URL=https://github.com/OWNER/OpenRA-fork browser-distributable\n`
	: repository != null ? `Repository: ${repository}\n` +
		`Commit: ${commit}\n` +
		`Commit link: ${repository}/commit/${commit}\n` +
		`Source archive: ${repository}/archive/${commit}.tar.gz\n`
	: `Commit: ${commit}\n` +
		`Commit link: ${explicitCommitUrl}\n` +
		`Source archive: ${explicitArchiveUrl}\n`;
const sourceNotice = `OpenRA Browser corresponding source\n` +
	`===================================\n\n` +
	sourceLocation +
	`Working tree had uncommitted changes at build time: ${dirty ? 'yes' : 'no'}\n\n` +
	`The source above is provided under the GNU General Public License, version 3\n` +
	`or (at your option) any later version. See COPYING in this artifact.\n`;

const dotnetNotices = await dotnetThirdPartyNotices(bundle);
await Promise.all([
	fs.copyFile(path.join(repoRoot, 'COPYING'), path.join(bundle, 'COPYING')),
	fs.copyFile(path.join(packaging, 'COPYING-GPL-2.0.txt'), path.join(bundle, 'COPYING-GPL-2.0.txt')),
	fs.copyFile(path.join(packaging, 'COPYING-LGPL-2.1.txt'), path.join(bundle, 'COPYING-LGPL-2.1.txt')),
	fs.copyFile(path.join(packaging, 'COPYING-LGPL-3.0.txt'), path.join(bundle, 'COPYING-LGPL-3.0.txt')),
	fs.copyFile(
		path.join(packaging, 'THIRD-PARTY-NOTICES.txt'),
		path.join(bundle, 'THIRD-PARTY-NOTICES.txt')),
	fs.copyFile(dotnetNotices, path.join(bundle, 'DOTNET-THIRD-PARTY-NOTICES.txt')),
	fs.writeFile(path.join(bundle, 'SOURCE-CODE.txt'), sourceNotice)
]);

// Report the RULE, not a count of names. The old message said "verified N forbidden content
// paths", where N came from EA's manifest — a number that shrank to zero the moment the manifest
// was deleted, while still printing as if something had been verified.
console.log(`[browser-package] no ${[...FORBIDDEN_CONTENT_EXTENSIONS].join('/')} content in the ` +
	`bundle or embedded VFS; ${noticedPackages} non-Microsoft runtime package notices; ` +
	'installed compliance files');
