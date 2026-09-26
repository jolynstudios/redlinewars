// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

// INF-08: published ratings must be reproducible from checked-in evidence.
// Historical pre-era matches are deliberately outside that claim. The strict
// git-index check arms itself when an outcome carries the current benchmark
// era lock; until then the gate reports an explicit empty range instead of
// pretending that a nonexistent published series proved completeness.
//
// Independently, a throwaway directory exercises the real .gitignore rules on
// real paths. This proves the policy before provider spend without weakening
// "tracked" into "not ignored": once era-locked evidence exists, git ls-files
// remains the only source of truth for retention.

import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsDirectory, '../..');
const matchResultsDirectory = path.join(testsDirectory, 'match-results');
const leaderboardPath = path.join(matchResultsDirectory, 'LEADERBOARD.md');
const leaderboardSourcePath = path.join(testsDirectory, 'leaderboard.mjs');
const eraLockPath = path.join(testsDirectory, 'benchmark-lockstep-v1.lock.json');
const matchResultsPrefix = 'OpenRA.Browser/tests/match-results/';
const CurrentEraEvidencePrefix = 'benchmark-lockstep-v1-';
const syntheticMatchPrefix = `${matchResultsPrefix}${CurrentEraEvidencePrefix}gate/`;
const EvidenceBasenames = new Set([
	'outcome.json',
	'metrics.json',
	'scorecard.md',
	'quarantine.json',
	'log.jsonl',
	'winner.txt'
]);
const EvidenceSuffixes = Object.freeze([
	'.series-report.json',
	'.sweep-report.json',
	'.sweep-ledger.json',
	'.era-stamp.json',
	'.lock.json'
]);
const NeverCommitPatterns = Object.freeze([
	/\.(?:png|jpe?g|webp|gif)$/i,
	/(?:^|\/)log-superseded-[^/]*\.jsonl$/i,
	/\.(?:out|log|pid|tmp)$/i,
	/(?:^|\/)\.env(?:\.|$)/i
]);
const CredentialPatterns = Object.freeze([
	{ name: 'OpenAI/OpenRouter-style secret', expression: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{ name: 'Anthropic secret', expression: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
	{ name: 'Google API secret', expression: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
	{ name: 'Bearer credential', expression: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{16,}\b/g },
	{
		name: 'credential assignment',
		expression: /\b(?:authorization|api[_-]?key)\b["'\s]*[:=]["'\s]*[A-Za-z0-9._~+/=-]{16,}/gi
	},
	{ name: 'private key', expression: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g }
]);

let checks = 0;

function assert(condition, message) {
	if (!condition)
		throw new Error(message);
}

function ok(message) {
	checks++;
	console.log(`ok: ${message}`);
}

function git(args) {
	const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024
	});
	assert(result.status === 0,
		`git ${args.join(' ')} exited ${result.status ?? result.signal}: ${result.stderr || result.stdout}`);
	return result.stdout;
}

function filesUnder(root) {
	if (!existsSync(root))
		return [];

	const files = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory())
			files.push(...filesUnder(absolute));
		else if (entry.isFile())
			files.push(absolute);
	}

	return files;
}

function repositoryRelative(absolute) {
	return path.relative(repositoryRoot, absolute).split(path.sep).join('/');
}

function isPublicationEvidence(relative) {
	const normalized = relative.replaceAll('\\', '/');
	if (!normalized.startsWith(matchResultsPrefix))
		return false;

	const underResults = normalized.slice(matchResultsPrefix.length);
	if (underResults === 'LEADERBOARD.md')
		return true;
	if (!underResults.startsWith(CurrentEraEvidencePrefix))
		return false;

	const basename = path.posix.basename(underResults);
	return EvidenceBasenames.has(basename) ||
		EvidenceSuffixes.some(suffix => basename.endsWith(suffix));
}

function isNeverCommit(relative) {
	const normalized = relative.replaceAll('\\', '/');
	return normalized.startsWith(matchResultsPrefix) &&
		(!isPublicationEvidence(normalized) ||
			NeverCommitPatterns.some(pattern => pattern.test(normalized)));
}

function validateTracked(required, tracked) {
	const missing = [...required].filter(file => !tracked.has(file)).sort();
	assert(missing.length === 0,
		`published evidence is not tracked: ${missing.join(', ')}`);
}

function validateNeverCommit(tracked) {
	const forbidden = [...tracked].filter(isNeverCommit).sort();
	assert(forbidden.length === 0,
		`never-commit artifact is tracked: ${forbidden.join(', ')}`);
}

function validatePublishedScope(tracked, published) {
	const unpublished = [...tracked]
		.filter(isPublicationEvidence)
		.filter(file => !published.has(file))
		.sort();
	assert(unpublished.length === 0,
		`pre-era or unpublished evidence is tracked: ${unpublished.join(', ')}`);
}

function assertCredentialFree(entries) {
	for (const [relative, content] of entries) {
		for (const { name, expression } of CredentialPatterns) {
			expression.lastIndex = 0;
			assert(!expression.test(content), `${relative} contains a key-shaped ${name}`);
		}
	}
}

function expectFailure(action, pattern, label) {
	let message = null;
	try {
		action();
	} catch (error) {
		message = error.message;
	}

	assert(message != null && pattern.test(message),
		`${label} did not fail for the expected reason${message == null ? '' : `: ${message}`}`);
}

function checkIgnored(relative, expectedIgnored) {
	const result = spawnSync('git', ['-C', repositoryRoot, 'check-ignore', '-v', '--no-index', relative], {
		encoding: 'utf8'
	});
	assert(result.status === 0,
		`git check-ignore failed for ${relative}: ${result.stderr || result.stdout}`);
	const sourceRule = result.stdout.split('\t', 1)[0];
	const rule = sourceRule.slice(sourceRule.lastIndexOf(':') + 1);
	const ignored = !rule.startsWith('!');
	assert(ignored === expectedIgnored,
		`${relative} resolves through '${rule}' as ${ignored ? 'ignored' : 'trackable'}, ` +
		`expected ${expectedIgnored ? 'ignored' : 'trackable'}`);
}

function lockHashOf(document) {
	return document?.eraLock?.lockHash ?? document?.report?.eraLock?.lockHash ??
		document?.lockHash ?? null;
}

function parseJson(absolute) {
	try {
		return JSON.parse(readFileSync(absolute, 'utf8'));
	} catch (error) {
		throw new Error(`${repositoryRelative(absolute)} is not valid JSON: ${error.message}`);
	}
}

function currentEraEvidence(currentLockHash, tracked) {
	const allFiles = filesUnder(matchResultsDirectory);
	const currentOutcomes = allFiles
		.filter(file => path.basename(file) === 'outcome.json')
		.filter(file => lockHashOf(parseJson(file)) === currentLockHash);
	assert(existsSync(leaderboardPath),
		'match-results/LEADERBOARD.md is missing');
	const required = new Set([repositoryRelative(leaderboardPath)]);

	for (const outcome of currentOutcomes) {
		const directory = path.dirname(outcome);
		const log = path.join(directory, 'log.jsonl');
		assert(existsSync(log),
			`${repositoryRelative(outcome)} is era-locked but its decision transcript log.jsonl is missing`);
		required.add(repositoryRelative(outcome));
		required.add(repositoryRelative(log));
		for (const file of filesUnder(directory)) {
			const relative = repositoryRelative(file);
			if (isPublicationEvidence(relative))
				required.add(relative);
		}
	}

	const currentLabels = new Set(currentOutcomes.map(outcome => path.basename(path.dirname(outcome))));
	const currentSeriesFiles = allFiles
		.filter(file => EvidenceSuffixes.some(suffix => path.basename(file).endsWith(suffix)))
		.filter(file => {
			const document = parseJson(file);
			if (lockHashOf(document) === currentLockHash)
				return true;

			// The resumable ledger is bound to the manifest/schedule digests
			// instead of copying the era lock. Its accepted labels bind it to
			// the era-stamped outcome directories retained beside it.
			return path.basename(file).endsWith('.sweep-ledger.json') &&
				Array.isArray(document.entries) &&
				document.entries.some(entry => currentLabels.has(entry?.label));
		});
	for (const file of currentSeriesFiles)
		required.add(repositoryRelative(file));

	validateTracked(required, tracked);
	return { matchCount: currentOutcomes.length, seriesFileCount: currentSeriesFiles.length, required };
}

mkdirSync(matchResultsDirectory, { recursive: true });
const fixtureDirectory = mkdtempSync(path.join(matchResultsDirectory,
	`${CurrentEraEvidencePrefix}publication-evidence-gate-`));
try {
	const lock = parseJson(eraLockPath);
	assert(typeof lock.lockHash === 'string' && /^[0-9a-f]{64}$/.test(lock.lockHash),
		'benchmark-lockstep-v1.lock.json has no valid lockHash');

	const safeFixtureContent = new Map();
	const allowedFixtureNames = [
		'outcome.json',
		'metrics.json',
		'scorecard.md',
		'quarantine.json',
		'log.jsonl',
		'winner.txt',
		'gate.series-report.json',
		'gate.sweep-report.json',
		'gate.sweep-ledger.json',
		'gate.era-stamp.json',
		'gate.lock.json'
	];
	const ignoredFixtureNames = [
		'final.png',
		'shot-00.png',
		'runner.out',
		'sidecar.log',
		'runner.pid',
		'log-superseded-123.jsonl',
		'.env',
		'notes.txt'
	];
	for (const name of [...allowedFixtureNames, ...ignoredFixtureNames]) {
		const absolute = path.join(fixtureDirectory, name);
		const content = allowedFixtureNames.includes(name) ? '{"safe":true}\n' : 'never commit\n';
		writeFileSync(absolute, content);
		if (allowedFixtureNames.includes(name))
			safeFixtureContent.set(repositoryRelative(absolute), content);
	}

	checkIgnored(repositoryRelative(leaderboardPath), false);
	for (const name of allowedFixtureNames)
		checkIgnored(repositoryRelative(path.join(fixtureDirectory, name)), false);
	for (const name of ignoredFixtureNames)
		checkIgnored(repositoryRelative(path.join(fixtureDirectory, name)), true);
	ok(`real ignore rules retain ${allowedFixtureNames.length + 1} evidence names and reject ` +
		`${ignoredFixtureNames.length} never-commit names`);

	const tracked = new Set(git(['ls-files', '-z', '--', 'OpenRA.Browser/tests/match-results'])
		.split('\0').filter(Boolean));
	const fixtureOutcomePath = path.join(fixtureDirectory, 'outcome.json');
	writeFileSync(fixtureOutcomePath, `${JSON.stringify({ eraLock: { lockHash: lock.lockHash } })}\n`);
	expectFailure(() => currentEraEvidence(lock.lockHash, tracked), /published evidence is not tracked:/,
		'era-locked completeness activation');
	writeFileSync(fixtureOutcomePath, '{"safe":true}\n');

	const leaderboardSource = readFileSync(leaderboardSourcePath, 'utf8');
	const leaderboardInputs = new Set([...leaderboardSource.matchAll(/path\.join\(dir,\s*'([^']+)'\)/g)]
		.map(match => match[1]));
	assert(['metrics.json', 'outcome.json', 'log.jsonl', 'winner.txt']
		.every(name => leaderboardInputs.has(name)),
		'leaderboard input inventory no longer exposes every rating input to the retention gate');
	assert([...leaderboardInputs].every(name =>
		isPublicationEvidence(`${syntheticMatchPrefix}${name}`)),
		`leaderboard reads evidence outside the publication allowlist: ${[...leaderboardInputs]
			.filter(name => !isPublicationEvidence(`${syntheticMatchPrefix}${name}`)).join(', ')}`);
	ok(`all ${leaderboardInputs.size} leaderboard input names are publication evidence`);

	const current = currentEraEvidence(lock.lockHash, tracked);
	ok(current.matchCount === 0
		? `published current-era range is empty (0 matches, ${current.seriesFileCount} series files); tracking check armed`
		: `all evidence for ${current.matchCount} current-era matches and ${current.seriesFileCount} series files is tracked`);

	validateNeverCommit(tracked);
	validatePublishedScope(tracked, current.required);
	ok(`no never-commit, pre-era, or unpublished artifact appears in the tracked evidence set ` +
		`(${tracked.size} tracked files inspected)`);

	const credentialEntries = new Map(safeFixtureContent);
	for (const relative of tracked) {
		if (isPublicationEvidence(relative))
			credentialEntries.set(relative, readFileSync(path.join(repositoryRoot, relative), 'utf8'));
	}
	assertCredentialFree(credentialEntries);
	ok(`credential scan passed across ${credentialEntries.size} tracked-or-fixture evidence files`);

	const synthetic = new Set([
		`${syntheticMatchPrefix}outcome.json`,
		`${syntheticMatchPrefix}metrics.json`,
		`${syntheticMatchPrefix}log.jsonl`
	]);
	const incomplete = new Set(synthetic);
	incomplete.delete(`${syntheticMatchPrefix}outcome.json`);
	expectFailure(() => validateTracked(synthetic, incomplete), /published evidence is not tracked: .*outcome\.json/,
		'completeness mutation');
	expectFailure(() => validateNeverCommit(new Set([
		...synthetic,
		`${syntheticMatchPrefix}final.png`
	])), /never-commit artifact is tracked: .*final\.png/, 'never-commit mutation');
	expectFailure(() => validateNeverCommit(new Set([
		...synthetic,
		`${matchResultsPrefix}pre-era/log.jsonl`
	])), /never-commit artifact is tracked: .*pre-era\/log\.jsonl/, 'pre-era mutation');
	expectFailure(() => validatePublishedScope(new Set([
		...synthetic,
		`${matchResultsPrefix}${CurrentEraEvidencePrefix}unpublished/log.jsonl`
	]), synthetic), /pre-era or unpublished evidence is tracked: .*unpublished\/log\.jsonl/,
	'unpublished scope mutation');
	expectFailure(() => assertCredentialFree(new Map([
		[`${syntheticMatchPrefix}log.jsonl`, '{"authorization":"Bearer abcdefghijklmnopqrstuvwxyz"}\n']
	])), /contains a key-shaped Bearer credential/, 'credential mutation');
	ok('negative mutations independently reject missing evidence, tracked bulk, pre-era evidence, and key-shaped content');

	console.log('OK the published evidence set is complete, tracked, and free of never-commit files');
	console.log(`publication evidence gate passed (${checks} checks)`);
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	process.exitCode = 1;
} finally {
	rmSync(fixtureDirectory, { recursive: true, force: true });
}
