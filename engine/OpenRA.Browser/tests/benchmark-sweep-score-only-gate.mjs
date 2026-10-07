// Zero-spend behavioral gate for offline sweep re-scoring. Evidence is created
// by deterministic in-process fixtures; no browser, sidecar, or provider exists.
import { spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from './benchmark-calibration-lib.mjs';
import {
	resolveSweep,
	runResumableSweep,
	runScriptedSweep,
	scoreExistingSweep,
	scriptedOutcome
} from './benchmark-sweep-runner.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testsDirectory, '../..');
const fixturePath = resolve(testsDirectory, 'benchmark-sweep/benchmark-sweep-v1.fixture.json');
const calibrationPath = resolve(testsDirectory, 'benchmark-calibration/golden-score-v1.frozen-test.json');
const sweepRunnerPath = resolve(testsDirectory, 'benchmark-sweep-runner.mjs');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'openra-benchmark-score-only-'));
let checks = 0;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function ok(message) {
	checks++;
	console.log(`ok: ${message}`);
}

function writeOutcome(matchRoot, game, calibration) {
	const outcome = scriptedOutcome(game, calibration);
	outcome.totalSpendUsd = 0;
	outcome.spendFinal = true;
	const target = resolve(matchRoot, game.label, 'outcome.json');
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${JSON.stringify(outcome, null, 1)}\n`);
}

function evidenceHashes(ledgerPath, matchRoot, games) {
	return {
		ledger: sha256(readFileSync(ledgerPath, 'utf8')),
		outcomes: games.map(game =>
			sha256(readFileSync(resolve(matchRoot, game.label, 'outcome.json'), 'utf8')))
	};
}

async function expectReject(action, pattern, message) {
	let rejected = false;
	try {
		await action();
	} catch (error) {
		rejected = pattern.test(error.message);
	}
	assert(rejected, message);
}

try {
	const manifest = JSON.parse(readFileSync(fixturePath, 'utf8'));
	manifest.seriesId = 'score-only-gate';
	manifest.calibration = calibrationPath;
	// This address deliberately has no listener. A successful score-only pass
	// therefore proves the runner never consulted its configured sidecar.
	manifest.runner.sidecarUrl = 'http://127.0.0.1:1';
	const manifestPath = resolve(temporaryDirectory, 'manifest.json');
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
	const resolved = resolveSweep(manifestPath, { allowTestVector: true });
	const matchRoot = resolve(temporaryDirectory, 'match-results');
	const ledgerPath = resolve(temporaryDirectory, 'series.sweep-ledger.json');

	const generated = await runResumableSweep(resolved, {
		matchRoot,
		ledgerPath,
		log: () => { },
		invokeGame: async game => {
			writeOutcome(matchRoot, game, resolved.calibration);
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	});
	assert(generated.complete === true && generated.records.length === resolved.schedule.games.length,
		'fixture evidence did not form a complete accepted series');
	const before = evidenceHashes(ledgerPath, matchRoot, resolved.schedule.games);

	const scored = scoreExistingSweep(resolved, { ledgerPath, matchRoot });
	const expected = runScriptedSweep(resolved).report;
	const { executionBudget, ...offlineAggregate } = scored.report;
	assert(scored.mode === 'score-only' && scored.evidenceCount === resolved.schedule.games.length &&
		canonicalJson(offlineAggregate) === canonicalJson(expected) &&
		executionBudget.chargedUsd === 0,
		'offline raw-outcome replay did not reproduce the deterministic aggregate');
	assert(canonicalJson(evidenceHashes(ledgerPath, matchRoot, resolved.schedule.games)) === canonicalJson(before),
		'direct score-only replay mutated its ledger or raw outcomes');
	ok('offline replay recomputes the complete aggregate without mutating evidence');

	const outputPath = resolve(temporaryDirectory, 'score-only-output.json');
	const cli = spawnSync(process.execPath, [
		sweepRunnerPath,
		'--manifest', manifestPath,
		'--score-only',
		'--test-fixture',
		'--ledger', ledgerPath,
		'--match-results', matchRoot,
		'--output', outputPath
	], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024
	});
	assert(cli.status === 0, `score-only CLI exited ${cli.status}:\n${cli.stdout}\n${cli.stderr}`);
	const cliReport = JSON.parse(cli.stdout);
	const cliOutput = JSON.parse(readFileSync(outputPath, 'utf8'));
	assert(cliOutput.mode === 'score-only' && cliOutput.evidenceCount === resolved.schedule.games.length &&
		canonicalJson(cliOutput.report) === canonicalJson(cliReport),
		'score-only CLI did not emit the same report to stdout and --output');
	assert(canonicalJson(evidenceHashes(ledgerPath, matchRoot, resolved.schedule.games)) === canonicalJson(before),
		'score-only CLI mutated paid evidence');
	ok('CLI score-only needs no live sidecar and writes only the requested report artifact');

	const staleScoreLedgerPath = resolve(temporaryDirectory, 'stale-score-ledger.json');
	const staleScoreLedger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
	staleScoreLedger.entries[0].scoreRecord.seats[0].score = 999;
	writeFileSync(staleScoreLedgerPath, `${JSON.stringify(staleScoreLedger, null, 1)}\n`);
	const rescored = scoreExistingSweep(resolved, { ledgerPath: staleScoreLedgerPath, matchRoot });
	assert(rescored.records[0].seats[0].score !== 999,
		'score-only trusted the cached ledger score instead of replaying raw telemetry');
	ok('cached score records are ignored in favor of current scoreGame over raw outcomes');

	const incompleteLedgerPath = resolve(temporaryDirectory, 'incomplete-ledger.json');
	const incompleteLedger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
	incompleteLedger.entries = incompleteLedger.entries.slice(0, -1);
	writeFileSync(incompleteLedgerPath, `${JSON.stringify(incompleteLedger, null, 1)}\n`);
	await expectReject(
		() => scoreExistingSweep(resolved, { ledgerPath: incompleteLedgerPath, matchRoot }),
		/complete accepted series; missing/,
		'score-only accepted an incomplete paid series');
	ok('incomplete series fail closed without invoking a match');

	const firstOutcomePath = resolve(matchRoot, resolved.schedule.games[0].label, 'outcome.json');
	const originalOutcome = readFileSync(firstOutcomePath, 'utf8');
	const changedOutcome = JSON.parse(originalOutcome);
	changedOutcome.assistance.guided = true;
	writeFileSync(firstOutcomePath, `${JSON.stringify(changedOutcome, null, 1)}\n`);
	await expectReject(
		() => scoreExistingSweep(resolved, { ledgerPath, matchRoot }),
		/evidence .* changed after ledger acceptance/,
		'score-only accepted an outcome changed after ledger acceptance');
	writeFileSync(firstOutcomePath, originalOutcome);
	ok('ledger hashes bind every raw outcome before offline scoring');

	const spendFlag = spawnSync(process.execPath, [
		sweepRunnerPath,
		'--manifest', manifestPath,
		'--score-only',
		'--test-fixture',
		'--confirm-provider-spend'
	], { cwd: repositoryRoot, encoding: 'utf8' });
	assert(spendFlag.status === 1 &&
		spendFlag.stderr.includes('--confirm-provider-spend is only valid with --execute'),
		'score-only accepted a provider-spend confirmation flag');
	ok('score-only is mechanically incompatible with provider-spend execution flags');

	console.log('benchmark sweep score-only gate passed');
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	process.exitCode = 1;
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
