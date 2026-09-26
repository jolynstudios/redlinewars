// Tier-0/1 era-lock stamp gate. It mints temporary current-tree locks and
// exercises match-runner --dry-run only: no browser, sidecar, provider, or spend.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Era1Files, EraFiles, deriveEraFiles } from './era-surfaces.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const browserRoot = path.resolve(testsDir, '..');
const eraLockScript = path.join(testsDir, 'era-lock.mjs');
const matchRunnerScript = path.join(testsDir, 'match-runner.mjs');
const benchmarkLockPath = path.join(testsDir, 'benchmark-lockstep-v1.lock.json');
const benchmarkEra = process.argv.slice(2).includes('--benchmark-era');
const tempDir = mkdtempSync(path.join(tmpdir(), 'openra-era-lock-stamp-'));
let checks = 0;

// Every place the benchmark spec version is written down. Listed rather than
// grepped: a new copy should require a decision here, not appear silently.
const SpecVersionSites = Object.freeze([
	'AgentMode/AgentModeContracts.cs',
	'AgentMode/AgentModeHost.cs',
	'agent-sidecar/src/contract-manifest.ts',
	'tests/benchmark-lockstep-fixture.mjs',
	'tests/benchmark-series-lib.mjs',
	'tests/benchmark-sweep-runner.mjs',
	'tests/match-runner.mjs'
]);

const ok = message => {
	checks++;
	console.log(`ok: ${message}`);
};

const assert = (condition, message) => {
	if (!condition)
		throw new Error(message);
};

const runNode = args => spawnSync(process.execPath, args, {
	cwd: browserRoot,
	encoding: 'utf8',
	maxBuffer: 8 * 1024 * 1024
});

const output = run => `${run.stdout ?? ''}${run.stderr ?? ''}`;

const assertStatus = (run, expected, label) => {
	assert(run.status === expected,
		`${label} exited ${run.status ?? run.signal}, expected ${expected}\n${output(run)}`);
};

const canonicalJson = value => {
	if (Array.isArray(value))
		return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object')
		return `{${Object.keys(value).sort().map(key =>
			`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
};

const sha256 = value => createHash('sha256').update(value).digest('hex');

const restamp = lock => {
	const { lockHash: ignored, ...body } = lock;
	return { ...body, lockHash: sha256(canonicalJson(body)) };
};

const writeLock = (name, lock) => {
	const lockPath = path.join(tempDir, name);
	writeFileSync(lockPath, `${JSON.stringify(lock, null, '\t')}\n`);
	return lockPath;
};

const generate = outPath => {
	const run = runNode([eraLockScript, 'generate', '--era', 'gate-tmp', '--out', outPath]);
	assertStatus(run, 0, `generate ${path.basename(outPath)}`);
};

const dryRun = lockPath => runNode([
	matchRunnerScript,
	'--era-lock', lockPath,
	'--dry-run'
]);

try {
	const eraLockSource = readFileSync(eraLockScript, 'utf8');
	const matchRunnerSource = readFileSync(matchRunnerScript, 'utf8');
	const duplicateArray = /const\s+\w*[Ee]ra\w*[Ff]ile\w*\s*=\s*\[/;
	assert(EraFiles.length > 0 && new Set(EraFiles).size === EraFiles.length,
		'shared era surface list is empty or contains duplicates');
	assert(eraLockSource.includes("import { EraFiles } from './era-surfaces.mjs';") &&
		matchRunnerSource.includes("import { EraFiles } from './era-surfaces.mjs';") &&
		!duplicateArray.test(eraLockSource) && !duplicateArray.test(matchRunnerSource),
		'era-lock and match-runner must import one shared era surface list without literal copies');
	ok('era-lock and match-runner share one era surface list');

	const firstPath = path.join(tempDir, 'gate-first.lock.json');
	const secondPath = path.join(tempDir, 'gate-second.lock.json');
	generate(firstPath);
	generate(secondPath);
	assert(readFileSync(firstPath, 'utf8') === readFileSync(secondPath, 'utf8'),
		'current-tree lock generation is not byte-stable');
	ok('era-lock generate is byte-stable');

	const clean = dryRun(firstPath);
	assertStatus(clean, 0, 'match-runner clean current-tree lock dry-run');
	ok('match-runner accepts a freshly generated current-tree files map');

	const cleanLock = JSON.parse(readFileSync(firstPath, 'utf8'));
	const driftedFile = Object.keys(cleanLock.files).sort()[0];
	const corruptLock = structuredClone(cleanLock);
	corruptLock.files[driftedFile] = corruptLock.files[driftedFile] === '0'.repeat(64)
		? '1'.repeat(64) : '0'.repeat(64);
	const corruptPath = writeLock('gate-corrupt.lock.json', restamp(corruptLock));
	const corrupt = dryRun(corruptPath);
	assertStatus(corrupt, 3, 'match-runner corrupted file hash dry-run');
	assert(output(corrupt).includes(driftedFile),
		`corrupted lock failure did not name ${driftedFile}\n${output(corrupt)}`);
	ok('altered file hash exits 3 and names the drifted surface');

	const removedLock = structuredClone(cleanLock);
	delete removedLock.files[driftedFile];
	const removedPath = writeLock('gate-removed.lock.json', restamp(removedLock));
	const removed = dryRun(removedPath);
	assertStatus(removed, 3, 'match-runner removed surface dry-run');
	assert(output(removed).includes(driftedFile),
		`removed-surface failure did not name ${driftedFile}\n${output(removed)}`);
	ok('missing files-map surface exits 3 via locked/live union comparison');

	const legacyLock = structuredClone(cleanLock);
	legacyLock.actionSchemaHash = cleanLock.files['agent-sidecar/src/contracts.ts'];
	const legacyPath = writeLock('gate-legacy-flat.lock.json', restamp(legacyLock));
	const legacy = dryRun(legacyPath);
	assertStatus(legacy, 2, 'match-runner legacy flat-key dry-run');
	assert(output(legacy).includes("malformed legacy field 'actionSchemaHash'"),
		`legacy flat-key failure was not explicit\n${output(legacy)}`);
	ok('legacy flat hash is rejected as malformed');

	// --- the minted benchmark era (graph node ERA-02) ----------------------
	// Only under --benchmark-era, so ERA-01's claim stays about the validator and
	// this one stays about the lock. Two nodes must not share an assertion.
	if (benchmarkEra) {
		const derived = deriveEraFiles();
		const listed = [...EraFiles];
		const undeclared = derived.filter(file => !listed.includes(file));
		const unreachable = listed.filter(file => !derived.includes(file));
		assert(undeclared.length === 0,
			`era surfaces exist in the tree but are not pinned: ${undeclared.join(', ')}`);
		assert(unreachable.length === 0,
			`pinned era surfaces no rule reaches: ${unreachable.join(', ')}`);
		ok(`the pinned list is the derivation, not a selection (${listed.length} surfaces)`);

		// A surface that stops being pinned narrows what the era means without
		// anyone deciding to. era1 died of an incomplete list; it may not shrink.
		const dropped = Era1Files.filter(file => !listed.includes(file));
		assert(dropped.length === 0, `the benchmark era dropped era1 surfaces: ${dropped.join(', ')}`);
		ok('the benchmark era is a strict superset of era1');

		const lock = JSON.parse(readFileSync(benchmarkLockPath, 'utf8'));
		assert(lock.era === 'benchmark-lockstep-v1', `minted lock is for era '${lock.era}'`);
		assert(restamp(lock).lockHash === lock.lockHash, 'minted lock does not match its own lockHash');
		const locked = Object.keys(lock.files).sort();
		assert(canonicalJson(locked) === canonicalJson(listed.slice().sort()),
			'the minted lock and the era surface list disagree about what is pinned');
		const unhashed = Object.entries(lock.files).filter(([, hash]) => hash === null).map(([file]) => file);
		assert(unhashed.length === 0, `minted lock pins surfaces that do not exist: ${unhashed.join(', ')}`);
		ok(`the minted lock pins every surface and nothing that is missing (${locked.length})`);

		// Regenerating into a scratch path must reproduce the committed lock byte
		// for byte, or the artifact is not the thing the tree describes.
		const remintPath = path.join(tempDir, 'gate-benchmark-remint.lock.json');
		assertStatus(runNode([eraLockScript, 'generate', '--era', 'benchmark-lockstep-v1', '--out', remintPath]),
			0, 'benchmark era regeneration');
		const reminted = JSON.parse(readFileSync(remintPath, 'utf8'));
		assert(canonicalJson(reminted.files) === canonicalJson(lock.files) &&
			canonicalJson(reminted.doctrineHashes) === canonicalJson(lock.doctrineHashes),
			'the committed benchmark lock does not reproduce from the current tree');
		ok('the committed benchmark lock reproduces from the tree it claims to pin');

		// The spec version is written out in a dozen places. If they can disagree,
		// two runs can call themselves the same era while meaning different things.
		const versions = new Map();
		for (const relative of SpecVersionSites)
			versions.set(relative, /benchmark-lockstep-v(\d+)/.exec(readFileSync(path.join(browserRoot, relative), 'utf8'))?.[1]);
		const disagreeing = [...versions].filter(([, version]) => version !== '1');
		assert(disagreeing.length === 0,
			`benchmark spec version split: ${disagreeing.map(([file, version]) => `${file}=${version ?? 'absent'}`).join(', ')}`);
		ok(`every declared benchmark spec version agrees (${versions.size} sites)`);

		// match-runner must accept the committed artifact, not merely a fresh one.
		assertStatus(dryRun(benchmarkLockPath), 0, 'match-runner committed benchmark lock dry-run');
		ok('match-runner accepts the committed benchmark era lock');

		console.log('OK the benchmark-lockstep era lock pins every measured surface');
	}

	console.log(`era lock stamp gate passed (${checks} checks)`);
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	process.exitCode = 1;
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
