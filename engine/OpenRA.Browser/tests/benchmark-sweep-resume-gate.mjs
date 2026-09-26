// Zero-spend behavioral gate for the paid sweep's crash-safe ledger and resume
// taxonomy. All matches are deterministic local fixtures; no browser, sidecar,
// or provider is started.
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
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	classifySweepAttempt,
	createSweepLedger,
	readSweepLedger,
	resolveSweep,
	runResumableSweep,
	scriptedOutcome,
	writeSweepLedger
} from './benchmark-sweep-runner.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(testsDirectory, 'benchmark-sweep/benchmark-sweep-v1.fixture.json');
const matchRunnerPath = resolve(testsDirectory, 'match-runner.mjs');
const sweepRunnerPath = resolve(testsDirectory, 'benchmark-sweep-runner.mjs');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'openra-benchmark-sweep-resume-'));
let checks = 0;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function ok(message) {
	checks++;
	console.log(`ok: ${message}`);
}

function outcomePath(matchRoot, game) {
	return resolve(matchRoot, game.label, 'outcome.json');
}

function writeOutcome(matchRoot, game, calibration, mutate = null) {
	const outcome = scriptedOutcome(game, calibration);
	mutate?.(outcome);
	const target = outcomePath(matchRoot, game);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${JSON.stringify(outcome, null, 1)}\n`);
	return outcome;
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
	const resolved = resolveSweep(fixturePath, { allowTestVector: true });
	const games = resolved.schedule.games;
	const failedGame = games[0];
	const unfinishedGame = games[1];
	const matchRoot = resolve(temporaryDirectory, 'match-results');
	const ledgerPath = resolve(temporaryDirectory, 'series.sweep-ledger.json');
	const firstInvocations = [];

	const first = await runResumableSweep(resolved, {
		matchRoot,
		ledgerPath,
		log: () => { },
		invokeGame: async game => {
			firstInvocations.push(game.label);
			const gameDirectory = resolve(matchRoot, game.label);
			mkdirSync(gameDirectory, { recursive: true });
			if (game.label === failedGame.label) {
				writeFileSync(resolve(gameDirectory, 'log.jsonl'), '{"kind":"page-crash"}\n');
				return { exitCode: 0, signal: null, timedOut: false, error: null };
			}
			writeOutcome(matchRoot, game, resolved.calibration,
				game.label === unfinishedGame.label ? outcome => { outcome.winner = null; } : null);
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	});
	assert(firstInvocations.length === games.length,
		'a missing outcome stopped the remaining scheduled fixture games');
	assert(first.complete === false && first.pendingLabels.length === 1 &&
		first.pendingLabels[0] === failedGame.label && first.records.length === games.length - 1,
		'first pass did not isolate exactly the crashed game as retryable');
	const firstKinds = new Set(first.ledger.entries.map(entry => entry.outcome));
	assert(firstKinds.has('resolved') && firstKinds.has('unfinished') &&
		firstKinds.has('infrastructure-censored'),
		'ledger did not exercise the resolved|unfinished|infrastructure-censored taxonomy');
	const censored = first.ledger.entries.find(entry => entry.label === failedGame.label);
	assert(censored.outcome === 'infrastructure-censored' && censored.scoreRecord == null,
		'dead-page attempt entered the model score records');
	assert(readSweepLedger(ledgerPath, resolved).entries.length === games.length,
		'atomic ledger was not readable after every first-pass attempt');
	assert(!readdirSync(dirname(ledgerPath)).some(name => name.startsWith(`${basename(ledgerPath)}.tmp-`)),
		'atomic ledger left a temporary file behind');
	const calibrationDrift = {
		...resolved,
		calibration: { ...resolved.calibration, digest: '0'.repeat(64) }
	};
	await expectReject(() => readSweepLedger(ledgerPath, calibrationDrift), /schedule digest/,
		'resume accepted a changed frozen calibration under the same manifest path');
	ok('dead page is censored without stopping or scoring the rest of the schedule');

	let accidentalFreshInvocations = 0;
	await expectReject(() => runResumableSweep(resolved, {
		matchRoot,
		ledgerPath,
		resume: false,
		log: () => { },
		invokeGame: async () => {
			accidentalFreshInvocations++;
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	}), /pass --resume/, 'existing ledger did not block an accidental paid fresh start');
	assert(accidentalFreshInvocations === 0, 'fresh-start guard fired after launching a game');
	const invalidResumeMode = spawnSync(process.execPath, [
		sweepRunnerPath,
		'--manifest', fixturePath,
		'--dry-run',
		'--test-fixture',
		'--resume'
	], { encoding: 'utf8', cwd: testsDirectory });
	assert(invalidResumeMode.status === 1 && invalidResumeMode.stderr.includes('--resume is only valid with --execute'),
		'CLI accepted --resume outside the provider-gated execute mode');
	ok('existing ledger blocks a fresh start before any invocation');

	const resumedInvocations = [];
	const resumed = await runResumableSweep(resolved, {
		matchRoot,
		ledgerPath,
		resume: true,
		log: () => { },
		invokeGame: async game => {
			resumedInvocations.push(game.label);
			writeOutcome(matchRoot, game, resolved.calibration);
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	});
	assert(resumed.complete === true && resumed.pendingLabels.length === 0 &&
		resumed.records.length === games.length && resumedInvocations.length === 1 &&
		resumedInvocations[0] === failedGame.label,
		'resume did not retry only the censored label and reconstruct the complete series');
	const attempts = resumed.ledger.entries.filter(entry => entry.label === failedGame.label);
	assert(attempts.length === 2 && attempts[0].outcome === 'infrastructure-censored' &&
		attempts[1].outcome === 'resolved' && attempts[1].scoreRecord != null,
		'resumed label did not preserve censored history before its accepted attempt');
	const archiveRoot = resolve(matchRoot, '.benchmark-sweep-superseded', failedGame.label);
	assert(existsSync(archiveRoot) && readdirSync(archiveRoot).length === 1 &&
		existsSync(resolve(archiveRoot, readdirSync(archiveRoot)[0], 'log.jsonl')),
		'retry did not preserve the crashed attempt artifacts');
	ok('resume retries only censored labels and preserves superseded evidence');

	const orphanRoot = resolve(temporaryDirectory, 'orphan-results');
	const orphanLedger = resolve(temporaryDirectory, 'orphan.sweep-ledger.json');
	mkdirSync(resolve(orphanRoot, failedGame.label), { recursive: true });
	await expectReject(() => runResumableSweep(resolved, {
		matchRoot: orphanRoot,
		ledgerPath: orphanLedger,
		log: () => { },
		invokeGame: async () => ({ exitCode: 0, signal: null, timedOut: false, error: null })
	}), /result directory already exists/, 'unledgered existing artifacts did not block a fresh paid start');
	assert(!existsSync(orphanLedger), 'fresh-start artifact guard wrote a misleading empty ledger');
	await expectReject(() => runResumableSweep(resolved, {
		matchRoot: resolve(temporaryDirectory, 'missing-resume-results'),
		ledgerPath: resolve(temporaryDirectory, 'missing.sweep-ledger.json'),
		resume: true,
		log: () => { },
		invokeGame: async () => ({ exitCode: 0, signal: null, timedOut: false, error: null })
	}), /--resume requires the existing sweep ledger/, '--resume guessed at missing paid history');
	ok('fresh and resume guards refuse to guess at unledgered paid history');

	const recoveredRoot = resolve(temporaryDirectory, 'recovered-results');
	const recoveredLedger = resolve(temporaryDirectory, 'recovered.sweep-ledger.json');
	writeSweepLedger(recoveredLedger, createSweepLedger(resolved));
	mkdirSync(resolve(recoveredRoot, failedGame.label), { recursive: true });
	writeFileSync(resolve(recoveredRoot, failedGame.label, 'log.jsonl'), '{"kind":"booted"}\n');
	const recovered = await runResumableSweep(resolved, {
		matchRoot: recoveredRoot,
		ledgerPath: recoveredLedger,
		resume: true,
		log: () => { },
		invokeGame: async game => {
			writeOutcome(recoveredRoot, game, resolved.calibration);
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	});
	const recoveredAttempts = recovered.ledger.entries.filter(entry => entry.label === failedGame.label);
	assert(recovered.complete === true && recoveredAttempts.length === 2 &&
		recoveredAttempts[0].outcome === 'infrastructure-censored' &&
		/recovered unledgered match artifacts/.test(recoveredAttempts[0].note) &&
		recoveredAttempts[1].outcome === 'resolved',
		'resume did not conservatively recover and retry artifacts written before their ledger entry');
	ok('resume records an interrupted unledgered artifact as censored before retrying it');

	const validOutcome = scriptedOutcome(failedGame, resolved.calibration);
	const watchdog = classifySweepAttempt(failedGame,
		{ exitCode: 0, signal: null, timedOut: true, error: null },
		{ outcome: validOutcome, sha256: '0'.repeat(64), error: null }, resolved.calibration);
	assert(watchdog.outcome === 'infrastructure-censored' && watchdog.scoreRecord == null &&
		/watchdog/.test(watchdog.note), 'watchdog kill was treated as a model result');
	validOutcome.infrastructureCensored = true;
	validOutcome.censorReason = 'browser page crashed';
	const pageCrash = classifySweepAttempt(failedGame,
		{ exitCode: 0, signal: null, timedOut: false, error: null },
		{ outcome: validOutcome, sha256: '0'.repeat(64), error: null }, resolved.calibration);
	assert(pageCrash.outcome === 'infrastructure-censored' && pageCrash.scoreRecord == null,
		'explicit page-crash outcome was treated as a model result');
	const matchRunnerSource = readFileSync(matchRunnerPath, 'utf8');
	assert(matchRunnerSource.includes('const infrastructureCensored = providerTerminal || harnessCensorReason != null;') &&
		matchRunnerSource.includes("page.on('crash'") &&
		matchRunnerSource.includes("state.oos === true ? 'determinism-desync'") &&
		matchRunnerSource.includes("state.state === 'failed' ? 'host-state-failed'"),
		'match-runner no longer stamps non-provider harness failures as infrastructure-censored');
	ok('watchdog, page crash, desync, and failed host state are infrastructure outcomes');

	console.log('benchmark sweep resume gate passed');
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	process.exitCode = 1;
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
