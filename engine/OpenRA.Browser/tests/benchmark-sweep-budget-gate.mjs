// Zero-spend behavioral gate for the paid sweep's between-game budget ceiling.
// All match outcomes and pricing responses are deterministic local fixtures.
import { createServer } from 'node:http';
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
import {
	createSweepLedger,
	estimateSweepGame,
	resolveSweep,
	runResumableSweep,
	scriptedOutcome,
	writeSweepLedger
} from './benchmark-sweep-runner.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(testsDirectory, 'benchmark-sweep/benchmark-sweep-v1.fixture.json');
const calibrationPath = resolve(testsDirectory, 'benchmark-calibration/golden-score-v1.frozen-test.json');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'openra-benchmark-sweep-budget-'));
let checks = 0;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function ok(message) {
	checks++;
	console.log(`ok: ${message}`);
}

function resolvedFixture(name, budgetTotalUsd) {
	const manifest = JSON.parse(readFileSync(fixturePath, 'utf8'));
	manifest.seriesId = `budget-${name}`;
	manifest.calibration = calibrationPath;
	manifest.budgetTotalUsd = budgetTotalUsd;
	const manifestPath = resolve(temporaryDirectory, `${name}.json`);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
	return resolveSweep(manifestPath, { allowTestVector: true });
}

function writeOutcome(matchRoot, game, calibration, spendUsd, spendFinal) {
	const outcome = scriptedOutcome(game, calibration);
	outcome.totalSpendUsd = spendUsd;
	outcome.spendFinal = spendFinal;
	const target = resolve(matchRoot, game.label, 'outcome.json');
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${JSON.stringify(outcome, null, 1)}\n`);
}

async function localEstimateEnvelope() {
	let requestBody = null;
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		const agents = requestBody.models.map((model, ordinal) => ({
			model,
			perDecisionUsd: ordinal === 0 ? 0.01 : 0.02,
			estimatedInputTokens: requestBody.estimatedInputTokens
		}));
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({
			agents,
			estimatedMatchUsd: 1.23,
			assumptions: requestBody
		}));
	});
	await new Promise((resolveListen, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	try {
		const resolved = resolvedFixture('estimate-envelope', 60);
		const game = resolved.schedule.games[0];
		const estimate = await estimateSweepGame(game, `http://127.0.0.1:${server.address().port}`);
		assert(requestBody.maxOutputTokens === 4096 && requestBody.estimatedInputTokens === 8000 &&
			requestBody.estimatedDecisionsPerAgent === game.decisionHorizon + 1 &&
			requestBody.strategyArsenalEnabled === false,
			'estimate request did not pin the raw model envelope and prematch barrier');
		assert(Math.abs(estimate - 2.46) < 1e-12,
			`strict+repair reservation envelope should be $2.46, got $${estimate}`);
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
}

try {
	let invalidBudgetRejected = false;
	try {
		resolvedFixture('invalid-budget', 0);
	} catch (error) {
		invalidBudgetRejected = /budgetTotalUsd/.test(error.message);
	}
	assert(invalidBudgetRejected, 'a missing or non-positive manifest budget was accepted');
	ok('the manifest requires a positive finite sweep ceiling');

	await localEstimateEnvelope();
	ok('local quote reserves the full strict plus repair decision envelope');

	const observed = resolvedFixture('observed', 4.5);
	const observedRoot = resolve(temporaryDirectory, 'observed-results');
	const observedLedger = resolve(temporaryDirectory, 'observed-ledger.json');
	const observedInvocations = [];
	const observedRun = await runResumableSweep(observed, {
		matchRoot: observedRoot,
		ledgerPath: observedLedger,
		log: () => { },
		estimateGame: async () => 2,
		invokeGame: async game => {
			observedInvocations.push(game.label);
			writeOutcome(observedRoot, game, observed.calibration, 1.5, true);
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	});
	assert(observedInvocations.length === 2 && observedRun.stop?.reason === 'budget' &&
		observedRun.budget.chargedUsd === 3 && observedRun.budget.committedUsd === 3 &&
		observedRun.ledger.activeReservation == null,
		`next game launched without room for its full reservation: ${JSON.stringify({
			invocations: observedInvocations.length,
			stop: observedRun.stop,
			budget: observedRun.budget,
			entries: observedRun.ledger.entries.map(entry => ({
				spendUsd: entry.spendUsd,
				estimatedSpendUsd: entry.estimatedSpendUsd,
				chargedSpendUsd: entry.chargedSpendUsd,
				spendBasis: entry.spendBasis
			}))
		})}`);
	assert(observedRun.ledger.entries.every(entry => entry.estimatedSpendUsd === 2 &&
		entry.chargedSpendUsd === 1.5 && entry.spendBasis === 'observed'),
		'parseable terminal spend did not replace the conservative reservation');
	ok('the next match is blocked before launch when its reservation would exceed the ceiling');

	const unknown = resolvedFixture('unknown', 4);
	const unknownRoot = resolve(temporaryDirectory, 'unknown-results');
	const unknownInvocations = [];
	const unknownRun = await runResumableSweep(unknown, {
		matchRoot: unknownRoot,
		ledgerPath: resolve(temporaryDirectory, 'unknown-ledger.json'),
		log: () => { },
		estimateGame: async () => 2,
		invokeGame: async game => {
			unknownInvocations.push(game.label);
			writeOutcome(unknownRoot, game, unknown.calibration, 0, false);
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	});
	assert(unknownInvocations.length === 2 && unknownRun.stop?.reason === 'budget' &&
		unknownRun.budget.chargedUsd === 4,
		'unparseable spend did not consume the full estimate before the next launch');
	assert(unknownRun.ledger.entries.every(entry => entry.spendUsd == null &&
		entry.chargedSpendUsd === 2 && entry.spendBasis === 'reserved-estimate'),
		'unknown spend was not charged at the full stored reservation');
	ok('unknown or non-final spend is charged at the full estimate');

	const interrupted = resolvedFixture('interrupted', 6);
	const interruptedRoot = resolve(temporaryDirectory, 'interrupted-results');
	const interruptedLedgerPath = resolve(temporaryDirectory, 'interrupted-ledger.json');
	const interruptedGame = interrupted.schedule.games[0];
	const interruptedLedger = createSweepLedger(interrupted);
	interruptedLedger.activeReservation = {
		label: interruptedGame.label,
		gameId: interruptedGame.gameId,
		attempt: 1,
		estimatedSpendUsd: 3,
		startedAt: '2026-07-26T10:00:00.000Z'
	};
	writeSweepLedger(interruptedLedgerPath, interruptedLedger);
	mkdirSync(resolve(interruptedRoot, interruptedGame.label), { recursive: true });
	writeFileSync(resolve(interruptedRoot, interruptedGame.label, 'log.jsonl'), '{"kind":"boot"}\n');
	const interruptedInvocations = [];
	const interruptedRun = await runResumableSweep(interrupted, {
		matchRoot: interruptedRoot,
		ledgerPath: interruptedLedgerPath,
		resume: true,
		log: () => { },
		estimateGame: async () => 3,
		invokeGame: async game => {
			interruptedInvocations.push(game.label);
			writeOutcome(interruptedRoot, game, interrupted.calibration, 1, true);
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	});
	const interruptedAttempts = interruptedRun.ledger.entries
		.filter(entry => entry.label === interruptedGame.label);
	assert(interruptedInvocations.length === 1 && interruptedInvocations[0] === interruptedGame.label &&
		interruptedAttempts.length === 2 &&
		interruptedAttempts[0].outcome === 'infrastructure-censored' &&
		interruptedAttempts[0].chargedSpendUsd === 3 &&
		interruptedAttempts[0].spendBasis === 'reserved-estimate' &&
		interruptedAttempts[1].outcome !== 'infrastructure-censored' &&
		interruptedRun.stop?.reason === 'budget',
		'interrupted active reservation was forgotten, scored, or not charged before retry');
	ok('resume charges and censors an interrupted active reservation before retry');

	const estimateFailure = resolvedFixture('estimate-failure', 10);
	let estimateFailureInvocations = 0;
	const estimateFailureRun = await runResumableSweep(estimateFailure, {
		matchRoot: resolve(temporaryDirectory, 'estimate-failure-results'),
		ledgerPath: resolve(temporaryDirectory, 'estimate-failure-ledger.json'),
		log: () => { },
		estimateGame: async () => { throw new Error('pricing unavailable'); },
		invokeGame: async () => {
			estimateFailureInvocations++;
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	});
	assert(estimateFailureInvocations === 0 && estimateFailureRun.stop?.reason === 'estimate' &&
		estimateFailureRun.ledger.entries.length === 0 &&
		estimateFailureRun.ledger.activeReservation == null,
		'estimate failure reached a paid match invocation');
	ok('a missing price estimate stops before launch without inventing spend');

	const overrun = resolvedFixture('estimate-overrun', 1);
	const overrunRoot = resolve(temporaryDirectory, 'estimate-overrun-results');
	let overrunInvocations = 0;
	const overrunRun = await runResumableSweep(overrun, {
		matchRoot: overrunRoot,
		ledgerPath: resolve(temporaryDirectory, 'estimate-overrun-ledger.json'),
		log: () => { },
		estimateGame: async () => 1,
		invokeGame: async game => {
			overrunInvocations++;
			writeOutcome(overrunRoot, game, overrun.calibration, 1.25, true);
			return { exitCode: 0, signal: null, timedOut: false, error: null };
		}
	});
	assert(overrunInvocations === 1 && overrunRun.stop?.reason === 'budget-estimate-overrun' &&
		overrunRun.complete === false && overrunRun.budget.chargedUsd === 1.25,
		'an estimate overrun did not halt publication and every later launch');
	ok('an observed estimate overrun is terminal instead of silently publishing');

	console.log('benchmark sweep budget gate passed');
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	process.exitCode = 1;
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
