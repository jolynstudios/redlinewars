// Paired benchmark-lockstep series runner and round-robin aggregator. Real execution is
// deliberately double-gated; dry-run and scripted-fixture modes cannot contact a provider.
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBenchmarkAnchorProxy } from './benchmark-anchor-proxy.mjs';
import { BenchmarkAnchorSpec } from './benchmark-scripted-anchor.mjs';
import { canonicalJson, sha256 } from './benchmark-calibration-lib.mjs';
import {
	aggregateSeries,
	buildPairedSchedule,
	canonicalModelId,
	loadCalibrationBundle,
	loadEraLockIdentity,
	matchRunnerArgs,
	scoreGame
} from './benchmark-series-lib.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const matchRunnerPath = resolve(testsDirectory, 'match-runner.mjs');
const EstimateInputTokens = 8000;
const RawTrackMaxOutputTokens = 4096;
const MaxProviderAttemptsPerDecision = 2;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function localUrl(raw, label) {
	const url = new URL(raw);
	assert(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
		url.username === '' && url.password === '', `${label} must be an unauthenticated loopback HTTP URL`);
	return url.toString().replace(/\/+$/, '');
}

function port(value, label) {
	assert(Number.isInteger(value) && value >= 1 && value <= 65535, `${label} must be an integer from 1-65535`);
	return value;
}

export function resolveSweep(manifestPath, options = {}) {
	const absoluteManifestPath = resolve(manifestPath);
	const manifest = readJson(absoluteManifestPath);
	const manifestDirectory = dirname(absoluteManifestPath);
	assert(typeof manifest.calibration === 'string' && manifest.calibration.length > 0,
		'manifest calibration path is required');
	const calibrationPath = resolve(manifestDirectory, manifest.calibration);
	const calibration = loadCalibrationBundle(calibrationPath, {
		mapId: manifest.map,
		allowTestVector: options.allowTestVector === true
	});
	let eraLockPath = null;
	let eraLock = null;
	if (Object.prototype.hasOwnProperty.call(manifest, 'eraLock')) {
		assert(typeof manifest.eraLock === 'string' && manifest.eraLock.length > 0,
			'manifest eraLock path must be non-empty when present');
		eraLockPath = resolve(manifestDirectory, manifest.eraLock);
		eraLock = loadEraLockIdentity(eraLockPath).normalized;
	}
	const schedule = buildPairedSchedule(manifest, {
		calibrationPath,
		eraLockPath,
		eraLock,
		anchorSpec: BenchmarkAnchorSpec
	});
	assert(Number.isFinite(manifest.budgetTotalUsd) && manifest.budgetTotalUsd > 0,
		'manifest budgetTotalUsd must be a positive finite number');
	assert(Number.isSafeInteger(manifest.decisionHorizon) && manifest.decisionHorizon >= 1 &&
		manifest.decisionHorizon + 1 <= 1000,
		'budgeted sweeps require decisionHorizon from 1 through 999 (including prematch barrier zero)');
	const runtime = {
		upstreamSidecarUrl: localUrl(manifest.runner?.sidecarUrl, 'runner.sidecarUrl'),
		matchPort: port(manifest.runner?.matchPort, 'runner.matchPort'),
		anchorProxyPort: port(manifest.runner?.anchorProxyPort, 'runner.anchorProxyPort')
	};
	assert(runtime.matchPort !== runtime.anchorProxyPort, 'match and anchor proxy ports must differ');
	const anchorProxyUrl = `http://127.0.0.1:${runtime.anchorProxyPort}`;
	const games = schedule.games.map(game => {
		const hasAnchor = game.seats.some(seat => seat.anchor);
		const args = matchRunnerArgs(game, {
			port: runtime.matchPort,
			sidecarUrl: hasAnchor ? anchorProxyUrl : runtime.upstreamSidecarUrl
		});
		return { ...game, hasAnchor, invocation: { executable: process.execPath, script: matchRunnerPath, args } };
	});
	return {
		manifestPath: absoluteManifestPath,
		manifest,
		calibrationPath,
		calibration: calibration.normalized,
		eraLockPath,
		eraLock,
		runtime,
		schedule: { ...schedule, games }
	};
}

function strength(modelId) {
	if (modelId === BenchmarkAnchorSpec.modelId) return 0.50;
	let hash = 2166136261;
	for (const byte of Buffer.from(modelId)) hash = Math.imul(hash ^ byte, 16777619);
	return 0.30 + ((hash >>> 0) % 401) / 1000;
}

function scriptedComponents(modelId, game, ordinal) {
	const value = strength(modelId);
	const seedNoise = ((game.seed % 19) - 9) * 3;
	const seatNoise = ordinal === 0 ? 35 : -35;
	return {
		liveHpAdjustedPower: Math.round(700 + value * 2400 + seedNoise + seatNoise),
		structuresByValue: Math.round(100 + value * 1800 + game.pairIndex * 40),
		economy: Math.round(2100 + value * 6500 + seedNoise * 2 + seatNoise),
		unitReplacementValue: Math.round(80 + value * 1300 + game.pairIndex * 30),
		tech: Math.round(1200 + value * 7200 + seedNoise),
		regionControl: 0.5 + value * 3 + (ordinal === 0 ? 0.05 : -0.05)
	};
}

export function scriptedOutcome(game, calibration) {
	const values = game.seats.map((seat, ordinal) => scriptedComponents(seat.modelId, game, ordinal));
	const providerEndpoint = {
		schemaVersion: 1,
		resolvedUrl: 'http://127.0.0.1:18788/api/v1',
		endpointHost: '127.0.0.1:18788',
		loopback: true
	};
	const barrierTrace = [0, 1, 2, 3].map(decisionId => ({
		barrierId: decisionId,
		seats: game.seats.map((seat, ordinal) => ({
			ordinal,
			decisionId,
			status: 'valid',
			durationMs: decisionId === 0 ? 0 : 20 + ordinal * 7 + game.pairIndex
		}))
	}));
	const identityRecords = barrierTrace.flatMap(barrier => barrier.seats.map(seat => {
		const requestedModelId = game.seats[seat.ordinal].modelId;
		const routeMatch = /^([A-Za-z0-9._-]+):(.+)$/.exec(requestedModelId);
		return {
			schemaVersion: 1,
			agentId: `scripted-agent-${seat.ordinal + 1}`,
			decisionId: seat.decisionId,
			requestedModelId,
			canonicalRequestedModelId: canonicalModelId(requestedModelId),
			requestedRoute: routeMatch?.[1] ?? null,
			attempts: [{
				label: 'scripted',
				servedModelId: canonicalModelId(requestedModelId),
				endpointHost: game.seats[seat.ordinal].anchor
					? '127.0.0.1:18789'
					: providerEndpoint.endpointHost,
				resolvedRoute: game.seats[seat.ordinal].anchor ? 'scripted-anchor' : 'scripted-fixture',
				substitutedFor: null
			}],
			valid: true,
			failureReason: null
		};
	}));
	let winner = null;
	// One terminal pair per matchup proves terminal override; the other pairs exercise the composite.
	if (game.pairIndex === 0) {
		const winnerOrdinal = strength(game.seats[0].modelId) >= strength(game.seats[1].modelId) ? 0 : 1;
		winner = `agent${winnerOrdinal + 1}`;
	}
	return {
		winner,
		infrastructureCensored: false,
		assistance: {
			arsenal: false,
			executor: false,
			guided: false,
			fallbackStrike: false,
			play: false,
			staffSeat: false,
			lessons: false
		},
		lessonsMode: 'off',
		eraLock: game.eraLock == null ? null : structuredClone(game.eraLock),
		providerEndpoint,
		modelIdentity: { schemaVersion: 1, records: identityRecords },
		perSeatSpendUsd: { agent1: 0, agent2: 0 },
		lastAgentsSnapshot: {
			agents: game.seats.map((seat, ordinal) => ({
				agentId: `scripted-agent-${ordinal + 1}`,
				controllerType: 'llm',
				fallbackTurns: 0,
				decisionOpportunities: 4,
				spentUsd: 0
			}))
		},
		benchmark: {
			enabled: true,
			specVersion: 'benchmark-lockstep-v1',
			decisionIntervalTicks: game.decisionIntervalTicks,
			requestedMapUid: game.map,
			calibration: {
				calibrationId: calibration.calibrationId,
				digest: calibration.digest,
				mapId: calibration.mapId,
				controlRegionHash: calibration.controlRegionHash
			},
			oos: false,
			barrierTrace,
			adjudication: {
				schemaVersion: 1,
				specVersion: 'benchmark-lockstep-v1',
				controlRegionCount: calibration.regions.length,
				seats: values.map((components, ordinal) => ({ ordinal, components }))
			}
		}
	};
}

export function runScriptedSweep(resolved) {
	assert(resolved.calibration.testOnly === true,
		'scripted-fixture mode requires the explicitly scoped frozen test vector');
	const records = resolved.schedule.games.map(game =>
		scoreGame(game, scriptedOutcome(game, resolved.calibration), resolved.calibration));
	return { records, report: aggregateSeries(resolved.manifest, resolved.schedule, records, resolved.calibration) };
}

function dryRunDocument(resolved) {
	return {
		mode: 'dry-run',
		seriesId: resolved.manifest.seriesId,
		map: resolved.manifest.map,
		eraLock: resolved.eraLock == null ? null : {
			path: resolved.eraLockPath,
			...resolved.eraLock
		},
		calibration: {
			path: resolved.calibrationPath,
			calibrationId: resolved.calibration.calibrationId,
			digest: resolved.calibration.digest,
			controlRegionHash: resolved.calibration.controlRegionHash,
			testOnly: resolved.calibration.testOnly
		},
		anchor: { ...BenchmarkAnchorSpec, rating: 1200, ratingMeaning: 'arbitrary fixed scale origin' },
		pairCount: resolved.manifest.pairCount,
		matchupCount: resolved.schedule.models.length * (resolved.schedule.models.length - 1) / 2,
		gameCount: resolved.schedule.games.length,
		decisionIntervalTicks: resolved.manifest.decisionIntervalTicks,
		dollarStop: false,
		budget: {
			ceilingUsd: resolved.manifest.budgetTotalUsd,
			enforcement: 'between-games-conservative-reservation',
			unknownSpendCharge: 'full-reserved-estimate',
			estimatedInputTokens: EstimateInputTokens,
			maxOutputTokens: RawTrackMaxOutputTokens,
			maxProviderAttemptsPerDecision: MaxProviderAttemptsPerDecision,
			estimatedDecisionsPerAgent: resolved.manifest.decisionHorizon + 1
		},
		games: resolved.schedule.games.map(game => ({
			gameId: game.gameId,
			pairId: game.pairId,
			leg: game.leg,
			seed: game.seed,
			seats: game.seats,
			hasAnchor: game.hasAnchor,
			invocation: [game.invocation.executable, game.invocation.script, ...game.invocation.args]
		}))
	};
}

const SweepLedgerSchemaVersion = 2;
const SweepOutcomes = new Set(['resolved', 'unfinished', 'infrastructure-censored']);
const SpendBases = new Set(['observed', 'reserved-estimate']);
const WatchdogGraceMs = 10 * 60_000;
const BudgetEpsilon = 1e-9;

function sweepManifestDigest(resolved) {
	return sha256(canonicalJson(resolved.manifest));
}

function sweepScheduleDigest(resolved) {
	return sha256(canonicalJson({
		calibration: {
			calibrationId: resolved.calibration.calibrationId,
			digest: resolved.calibration.digest,
			controlRegionHash: resolved.calibration.controlRegionHash
		},
		eraLock: resolved.eraLock,
		anchor: resolved.manifest.anchor,
		games: resolved.schedule.games.map(game => ({
			scheduleIndex: game.scheduleIndex,
			gameId: game.gameId,
			label: game.label,
			matchupId: game.matchupId,
			pairId: game.pairId,
			leg: game.leg,
			seed: game.seed,
			map: game.map,
			seats: game.seats,
			tickHorizon: game.tickHorizon,
			decisionHorizon: game.decisionHorizon,
			decisionTimeoutMs: game.decisionTimeoutMs,
			decisionIntervalTicks: game.decisionIntervalTicks,
			wallClockSafetyMinutes: game.wallClockSafetyMinutes,
			invocationArgs: game.invocation.args
		}))
	}));
}

export function defaultSweepLedgerPath(resolved) {
	return resolve(dirname(resolved.manifestPath), `${resolved.manifest.seriesId}.sweep-ledger.json`);
}

export function createSweepLedger(resolved) {
	return {
		schemaVersion: SweepLedgerSchemaVersion,
		seriesSpecVersion: resolved.manifest.seriesSpecVersion,
		seriesId: resolved.manifest.seriesId,
		manifestDigest: sweepManifestDigest(resolved),
		scheduleDigest: sweepScheduleDigest(resolved),
		budgetTotalUsd: resolved.manifest.budgetTotalUsd,
		activeReservation: null,
		entries: []
	};
}

function validateSweepLedger(ledger, resolved, ledgerPath) {
	const expectedTopLevel = [
		'activeReservation',
		'budgetTotalUsd',
		'entries',
		'manifestDigest',
		'scheduleDigest',
		'schemaVersion',
		'seriesId',
		'seriesSpecVersion'
	];
	assert(ledger != null && typeof ledger === 'object' && !Array.isArray(ledger),
		`sweep ledger ${ledgerPath} must contain an object`);
	assert(canonicalJson(Object.keys(ledger).sort()) === canonicalJson(expectedTopLevel),
		`sweep ledger ${ledgerPath} has unsupported top-level fields`);
	assert(ledger.schemaVersion === SweepLedgerSchemaVersion,
		`sweep ledger ${ledgerPath} schemaVersion must be ${SweepLedgerSchemaVersion}`);
	assert(ledger.seriesSpecVersion === resolved.manifest.seriesSpecVersion &&
		ledger.seriesId === resolved.manifest.seriesId,
		`sweep ledger ${ledgerPath} belongs to a different series`);
	assert(ledger.manifestDigest === sweepManifestDigest(resolved),
		`sweep ledger ${ledgerPath} manifest digest does not match this run`);
	assert(ledger.scheduleDigest === sweepScheduleDigest(resolved),
		`sweep ledger ${ledgerPath} schedule digest does not match this run`);
	assert(ledger.budgetTotalUsd === resolved.manifest.budgetTotalUsd,
		`sweep ledger ${ledgerPath} budget ceiling does not match this run`);
	assert(Array.isArray(ledger.entries), `sweep ledger ${ledgerPath} entries must be an array`);

	const byLabel = new Map();
	const scheduled = new Map(resolved.schedule.games.map(game => [game.label, game]));
	const expectedEntryKeys = [
		'attempt',
		'chargedSpendUsd',
		'estimatedSpendUsd',
		'exitCode',
		'finishedAt',
		'gameId',
		'label',
		'note',
		'outcome',
		'outcomeSha256',
		'scoreRecord',
		'signal',
		'spendBasis',
		'spendUsd',
		'startedAt',
		'timedOut',
		'winner'
	];
	for (const [index, entry] of ledger.entries.entries()) {
		assert(entry != null && typeof entry === 'object' && !Array.isArray(entry),
			`sweep ledger entry ${index} must be an object`);
		assert(canonicalJson(Object.keys(entry).sort()) === canonicalJson(expectedEntryKeys),
			`sweep ledger entry ${index} has unsupported fields`);
		const game = scheduled.get(entry.label);
		assert(game != null && entry.gameId === game.gameId,
			`sweep ledger entry ${index} does not match a scheduled label/game`);
		const attempts = byLabel.get(entry.label) ?? [];
		assert(!attempts.some(attempt => attempt.outcome !== 'infrastructure-censored'),
			`sweep ledger ${entry.label} contains an attempt after an accepted result`);
		assert(Number.isSafeInteger(entry.attempt) && entry.attempt === attempts.length + 1,
			`sweep ledger ${entry.label} attempts must be contiguous from 1`);
		assert(SweepOutcomes.has(entry.outcome), `sweep ledger ${entry.label} has invalid outcome '${entry.outcome}'`);
		assert(entry.startedAt == null || typeof entry.startedAt === 'string',
			`sweep ledger ${entry.label} startedAt must be a string or null`);
		assert(typeof entry.finishedAt === 'string', `sweep ledger ${entry.label} finishedAt must be a string`);
		assert(entry.exitCode == null || Number.isSafeInteger(entry.exitCode),
			`sweep ledger ${entry.label} exitCode must be an integer or null`);
		assert(entry.signal == null || typeof entry.signal === 'string',
			`sweep ledger ${entry.label} signal must be a string or null`);
		assert(typeof entry.timedOut === 'boolean', `sweep ledger ${entry.label} timedOut must be boolean`);
		assert(entry.spendUsd == null || Number.isFinite(entry.spendUsd) && entry.spendUsd >= 0,
			`sweep ledger ${entry.label} spendUsd must be non-negative or null`);
		assert(Number.isFinite(entry.estimatedSpendUsd) && entry.estimatedSpendUsd >= 0,
			`sweep ledger ${entry.label} estimatedSpendUsd must be non-negative`);
		assert(Number.isFinite(entry.chargedSpendUsd) && entry.chargedSpendUsd >= 0,
			`sweep ledger ${entry.label} chargedSpendUsd must be non-negative`);
		assert(SpendBases.has(entry.spendBasis),
			`sweep ledger ${entry.label} spendBasis must be observed or reserved-estimate`);
		if (entry.spendBasis === 'observed') {
			assert(entry.spendUsd != null && entry.chargedSpendUsd === entry.spendUsd,
				`sweep ledger ${entry.label} observed spend charge must equal spendUsd`);
		} else {
			assert(entry.spendUsd == null && entry.chargedSpendUsd === entry.estimatedSpendUsd,
				`sweep ledger ${entry.label} estimate-backed charge must equal its reservation`);
		}
		assert(entry.outcomeSha256 == null || /^[0-9a-f]{64}$/.test(entry.outcomeSha256),
			`sweep ledger ${entry.label} outcomeSha256 must be sha256 or null`);
		assert(typeof entry.note === 'string', `sweep ledger ${entry.label} note must be a string`);
		if (entry.outcome === 'infrastructure-censored')
			assert(entry.scoreRecord == null, `sweep ledger ${entry.label} censored attempt must not carry a score`);
		else {
			assert(entry.scoreRecord != null && entry.scoreRecord.gameId === game.gameId,
				`sweep ledger ${entry.label} accepted attempt must carry its score record`);
		}
		attempts.push(entry);
		byLabel.set(entry.label, attempts);
	}

	if (ledger.activeReservation != null) {
		const reservation = ledger.activeReservation;
		const expectedReservationKeys = ['attempt', 'estimatedSpendUsd', 'gameId', 'label', 'startedAt'];
		assert(typeof reservation === 'object' && !Array.isArray(reservation) &&
			canonicalJson(Object.keys(reservation).sort()) === canonicalJson(expectedReservationKeys),
			`sweep ledger ${ledgerPath} has a malformed active reservation`);
		const game = scheduled.get(reservation.label);
		assert(game != null && reservation.gameId === game.gameId,
			`sweep ledger ${ledgerPath} reservation does not match a scheduled label/game`);
		const attempts = byLabel.get(reservation.label) ?? [];
		assert(!attempts.some(attempt => attempt.outcome !== 'infrastructure-censored') &&
			reservation.attempt === attempts.length + 1,
			`sweep ledger ${ledgerPath} reservation is not the next retryable attempt`);
		assert(Number.isFinite(reservation.estimatedSpendUsd) && reservation.estimatedSpendUsd >= 0,
			`sweep ledger ${ledgerPath} reservation estimate must be non-negative`);
		assert(typeof reservation.startedAt === 'string',
			`sweep ledger ${ledgerPath} reservation startedAt must be a string`);
	}

	return ledger;
}

export function readSweepLedger(ledgerPath, resolved) {
	let ledger;
	try {
		ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
	} catch (error) {
		throw new Error(`cannot read sweep ledger ${ledgerPath}: ${error.message}; refusing to guess at paid history`);
	}
	return validateSweepLedger(ledger, resolved, ledgerPath);
}

export function writeSweepLedger(ledgerPath, ledger) {
	mkdirSync(dirname(ledgerPath), { recursive: true });
	const temporaryPath = `${ledgerPath}.tmp-${process.pid}`;
	writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 1)}\n`);
	renameSync(temporaryPath, ledgerPath);
}

function outcomeArtifact(outcomePath) {
	if (!existsSync(outcomePath))
		return { outcome: null, sha256: null, error: 'missing outcome.json' };
	let text;
	try {
		text = readFileSync(outcomePath, 'utf8');
		return { outcome: JSON.parse(text), sha256: sha256(text), error: null };
	} catch (error) {
		return { outcome: null, sha256: text == null ? null : sha256(text), error: `unreadable outcome.json: ${error.message}` };
	}
}

function outcomeSpend(outcome) {
	if (outcome?.spendFinal === false) return null;
	return typeof outcome?.totalSpendUsd === 'number' && Number.isFinite(outcome.totalSpendUsd) &&
		outcome.totalSpendUsd >= 0 ? outcome.totalSpendUsd : null;
}

function spendCharge(spendUsd, estimatedSpendUsd) {
	return spendUsd == null
		? { chargedSpendUsd: estimatedSpendUsd, spendBasis: 'reserved-estimate' }
		: { chargedSpendUsd: spendUsd, spendBasis: 'observed' };
}

export function sweepBudgetState(ledger) {
	const chargedUsd = ledger.entries.reduce((sum, entry) => sum + entry.chargedSpendUsd, 0);
	const reservedUsd = ledger.activeReservation?.estimatedSpendUsd ?? 0;
	return {
		ceilingUsd: ledger.budgetTotalUsd,
		chargedUsd,
		reservedUsd,
		committedUsd: chargedUsd + reservedUsd,
		remainingUsd: Math.max(0, ledger.budgetTotalUsd - chargedUsd - reservedUsd)
	};
}

export function classifySweepAttempt(game, run, artifact, calibration) {
	const infrastructure = note => ({
		outcome: 'infrastructure-censored',
		winner: null,
		spendUsd: outcomeSpend(artifact.outcome),
		scoreRecord: null,
		note
	});
	if (run.timedOut === true)
		return infrastructure('watchdog killed a hung match-runner');
	if (run.error != null)
		return infrastructure(`match-runner invocation failed: ${run.error}`);
	if (run.exitCode !== 0)
		return infrastructure(`match-runner exited ${run.exitCode ?? run.signal ?? 'without a status'}`);
	if (artifact.error != null)
		return infrastructure(artifact.error);
	if (artifact.outcome?.infrastructureCensored === true)
		return infrastructure(artifact.outcome.censorReason ?? 'match outcome classified infrastructure failure');

	let scoreRecord;
	try {
		scoreRecord = scoreGame(game, artifact.outcome, calibration);
	} catch (error) {
		return infrastructure(`outcome is not safely scorable: ${error.message}`);
	}
	return {
		outcome: artifact.outcome.winner == null ? 'unfinished' : 'resolved',
		winner: artifact.outcome.winner ?? null,
		spendUsd: outcomeSpend(artifact.outcome),
		scoreRecord,
		note: artifact.outcome.winner == null ? 'valid capped game without a terminal winner'
			: (artifact.outcome.how ?? 'engine-resolved winner')
	};
}

function acceptedEntryByLabel(ledger) {
	const accepted = new Map();
	for (const entry of ledger.entries)
		if (entry.outcome === 'resolved' || entry.outcome === 'unfinished')
			accepted.set(entry.label, entry);
	return accepted;
}

function acceptedScoreRecords(ledger, resolved, matchRoot) {
	const accepted = acceptedEntryByLabel(ledger);
	return resolved.schedule.games.flatMap(game => {
		const entry = accepted.get(game.label);
		if (entry == null) return [];
		const artifact = outcomeArtifact(resolve(matchRoot, game.label, 'outcome.json'));
		assert(artifact.error == null && artifact.sha256 === entry.outcomeSha256,
			`accepted evidence for ${game.label} is missing or changed since it entered the sweep ledger`);
		return [entry.scoreRecord];
	});
}

function archiveRetryArtifacts(matchRoot, game, attempt) {
	const matchDirectory = resolve(matchRoot, game.label);
	if (!existsSync(matchDirectory)) return null;
	const archiveRoot = resolve(matchRoot, '.benchmark-sweep-superseded', game.label);
	mkdirSync(archiveRoot, { recursive: true });
	let ordinal = 0;
	let archivePath;
	do {
		archivePath = resolve(archiveRoot, `attempt-${attempt}${ordinal === 0 ? '' : `-${ordinal}`}`);
		ordinal++;
	} while (existsSync(archivePath));
	renameSync(matchDirectory, archivePath);
	return archivePath;
}

function recoveredOrphanEntry(game, artifact, attempt, estimatedSpendUsd, startedAt, now, note) {
	const spendUsd = outcomeSpend(artifact.outcome);
	return {
		label: game.label,
		gameId: game.gameId,
		attempt,
		outcome: 'infrastructure-censored',
		winner: null,
		spendUsd,
		estimatedSpendUsd,
		...spendCharge(spendUsd, estimatedSpendUsd),
		startedAt,
		finishedAt: now(),
		exitCode: null,
		signal: null,
		timedOut: false,
		outcomeSha256: artifact.sha256,
		scoreRecord: null,
		note
	};
}

export async function runResumableSweep(resolved, options = {}) {
	const resume = options.resume === true;
	const matchRoot = resolve(options.matchRoot ?? resolve(testsDirectory, 'match-results'));
	const ledgerPath = resolve(options.ledgerPath ?? defaultSweepLedgerPath(resolved));
	const invokeGame = options.invokeGame;
	assert(typeof invokeGame === 'function', 'runResumableSweep requires an invokeGame function');
	const estimateGame = options.estimateGame ?? (resolved.calibration.testOnly ? async () => 0 : null);
	assert(typeof estimateGame === 'function',
		'runResumableSweep requires an estimateGame function for a production calibration');
	const now = options.now ?? (() => new Date().toISOString());
	const log = options.log ?? (message => console.error(message));
	const estimateFor = async game => {
		const estimate = await estimateGame(game);
		assert(Number.isFinite(estimate) && estimate >= 0,
			`spend estimate for ${game.label} must be a non-negative finite number`);
		return estimate;
	};
	mkdirSync(matchRoot, { recursive: true });

	let ledger;
	if (resume) {
		assert(existsSync(ledgerPath), `--resume requires the existing sweep ledger ${ledgerPath}`);
		ledger = readSweepLedger(ledgerPath, resolved);
	} else {
		assert(!existsSync(ledgerPath),
			`a sweep ledger already exists at ${ledgerPath}; pass --resume or move it aside deliberately`);
		for (const game of resolved.schedule.games)
			assert(!existsSync(resolve(matchRoot, game.label)),
				`result directory already exists for ${game.label}; pass --resume with its ledger or choose a new seriesId`);
		ledger = createSweepLedger(resolved);
		writeSweepLedger(ledgerPath, ledger);
	}

	if (resume) {
		if (ledger.activeReservation != null) {
			const reservation = ledger.activeReservation;
			const game = resolved.schedule.games.find(candidate => candidate.label === reservation.label);
			const artifact = outcomeArtifact(resolve(matchRoot, game.label, 'outcome.json'));
			ledger.entries.push(recoveredOrphanEntry(game, artifact, reservation.attempt,
				reservation.estimatedSpendUsd, reservation.startedAt, now,
				'recovered an active pre-launch spend reservation after an interrupted sweep; ' +
				'charged conservatively, retryable, never scored'));
			ledger.activeReservation = null;
			writeSweepLedger(ledgerPath, ledger);
		}

		const labelsInLedger = new Set(ledger.entries.map(entry => entry.label));
		for (const game of resolved.schedule.games) {
			const matchDirectory = resolve(matchRoot, game.label);
			if (!labelsInLedger.has(game.label) && existsSync(matchDirectory)) {
				const artifact = outcomeArtifact(resolve(matchDirectory, 'outcome.json'));
				const estimatedSpendUsd = await estimateFor(game);
				ledger.entries.push(recoveredOrphanEntry(game, artifact, 1, estimatedSpendUsd, null, now,
					'recovered unledgered match artifacts after an interrupted sweep; ' +
					'charged conservatively, retryable, never scored'));
				writeSweepLedger(ledgerPath, ledger);
				labelsInLedger.add(game.label);
			}
		}
	}

	const acceptedBeforeRun = acceptedEntryByLabel(ledger);
	const runnable = resolved.schedule.games.filter(game => !acceptedBeforeRun.has(game.label));
	let consecutiveInfrastructureFailures = 0;
	let stop = null;
	for (const game of runnable) {
		const priorAttempts = ledger.entries.filter(entry => entry.label === game.label);
		const attempt = priorAttempts.length + 1;
		let estimatedSpendUsd;
		try {
			estimatedSpendUsd = await estimateFor(game);
		} catch (error) {
			stop = { reason: 'estimate', detail: error.message };
			log(`[benchmark-sweep] stopping before ${game.label}: ${stop.detail}`);
			break;
		}
		const budgetBeforeLaunch = sweepBudgetState(ledger);
		if (budgetBeforeLaunch.committedUsd + estimatedSpendUsd >
			budgetBeforeLaunch.ceilingUsd + BudgetEpsilon) {
			stop = {
				reason: 'budget',
				detail: `charged $${budgetBeforeLaunch.chargedUsd.toFixed(6)}; reserving ` +
					`$${estimatedSpendUsd.toFixed(6)} for ${game.label} would exceed the ` +
					`$${budgetBeforeLaunch.ceilingUsd.toFixed(6)} ceiling`
			};
			log(`[benchmark-sweep] ${stop.detail}`);
			break;
		}
		archiveRetryArtifacts(matchRoot, game, Math.max(1, attempt - 1));
		const startedAt = now();
		ledger.activeReservation = {
			label: game.label,
			gameId: game.gameId,
			attempt,
			estimatedSpendUsd,
			startedAt
		};
		writeSweepLedger(ledgerPath, ledger);
		log(`[benchmark-sweep] ${game.scheduleIndex + 1}/${resolved.schedule.games.length} ` +
			`${game.gameId} attempt ${attempt}; reserved $${estimatedSpendUsd.toFixed(6)}`);
		let run;
		try {
			run = await invokeGame(game);
		} catch (error) {
			run = { exitCode: -1, signal: null, timedOut: false, error: error.message };
		}
		run ??= { exitCode: -1, signal: null, timedOut: false, error: 'invokeGame returned no result' };
		const finishedAt = now();
		const artifact = outcomeArtifact(resolve(matchRoot, game.label, 'outcome.json'));
		const classified = classifySweepAttempt(game, run, artifact, resolved.calibration);
		const charge = spendCharge(classified.spendUsd, estimatedSpendUsd);
		ledger.entries.push({
			label: game.label,
			gameId: game.gameId,
			attempt,
			outcome: classified.outcome,
			winner: classified.winner,
			spendUsd: classified.spendUsd,
			estimatedSpendUsd,
			...charge,
			startedAt,
			finishedAt,
			exitCode: Number.isSafeInteger(run.exitCode) ? run.exitCode : null,
			signal: typeof run.signal === 'string' ? run.signal : null,
			timedOut: run.timedOut === true,
			outcomeSha256: artifact.sha256,
			scoreRecord: classified.scoreRecord,
			note: classified.note
		});
		ledger.activeReservation = null;
		writeSweepLedger(ledgerPath, ledger);
		const budgetAfterLaunch = sweepBudgetState(ledger);
		log(`[benchmark-sweep] ${game.label}: charged $${charge.chargedSpendUsd.toFixed(6)} ` +
			`(${charge.spendBasis}); cumulative $${budgetAfterLaunch.chargedUsd.toFixed(6)} of ` +
			`$${budgetAfterLaunch.ceilingUsd.toFixed(6)}`);
		if (budgetAfterLaunch.chargedUsd > budgetAfterLaunch.ceilingUsd + BudgetEpsilon) {
			stop = {
				reason: 'budget-estimate-overrun',
				detail: `${game.label} reported $${charge.chargedSpendUsd.toFixed(6)}, above its ` +
					`$${estimatedSpendUsd.toFixed(6)} reservation; no further game may launch`
			};
			log(`[benchmark-sweep] ${stop.detail}`);
			break;
		}
		if (classified.outcome === 'infrastructure-censored') {
			consecutiveInfrastructureFailures++;
			if (consecutiveInfrastructureFailures >= 3) {
				log('[benchmark-sweep] stopping after 3 consecutive infrastructure-censored attempts');
				stop = { reason: 'infrastructure', detail: '3 consecutive infrastructure-censored attempts' };
				break;
			}
		} else
			consecutiveInfrastructureFailures = 0;
	}

	validateSweepLedger(ledger, resolved, ledgerPath);
	const records = acceptedScoreRecords(ledger, resolved, matchRoot);
	const accepted = acceptedEntryByLabel(ledger);
	const pendingLabels = resolved.schedule.games.filter(game => !accepted.has(game.label)).map(game => game.label);
	const budget = sweepBudgetState(ledger);
	return {
		ledgerPath,
		ledger,
		records,
		pendingLabels,
		budget,
		stop,
		complete: pendingLabels.length === 0 && budget.chargedUsd <= budget.ceilingUsd + BudgetEpsilon
	};
}

export function scoreExistingSweep(resolved, options = {}) {
	const matchRoot = resolve(options.matchRoot ?? resolve(testsDirectory, 'match-results'));
	const ledgerPath = resolve(options.ledgerPath ?? defaultSweepLedgerPath(resolved));
	assert(existsSync(ledgerPath), `--score-only requires the existing sweep ledger ${ledgerPath}`);
	const ledger = readSweepLedger(ledgerPath, resolved);
	assert(ledger.activeReservation == null,
		'--score-only refuses a sweep with an active reservation; resume or reconcile it first');
	const accepted = acceptedEntryByLabel(ledger);
	const missing = resolved.schedule.games.filter(game => !accepted.has(game.label));
	assert(missing.length === 0,
		`--score-only requires a complete accepted series; missing ${missing.map(game => game.label).join(', ')}`);

	const records = resolved.schedule.games.map(game => {
		const entry = accepted.get(game.label);
		const artifact = outcomeArtifact(resolve(matchRoot, game.label, 'outcome.json'));
		assert(artifact.error == null,
			`--score-only cannot read accepted evidence for ${game.label}: ${artifact.error}`);
		assert(artifact.sha256 === entry.outcomeSha256,
			`--score-only evidence for ${game.label} changed after ledger acceptance`);
		return scoreGame(game, artifact.outcome, resolved.calibration);
	});
	const budget = sweepBudgetState(ledger);
	assert(budget.chargedUsd <= budget.ceilingUsd + BudgetEpsilon,
		'--score-only refuses a series whose charged spend exceeds its manifest ceiling');
	return {
		mode: 'score-only',
		seriesId: resolved.manifest.seriesId,
		ledgerPath,
		matchRoot,
		evidenceCount: records.length,
		budget,
		records,
		report: {
			...aggregateSeries(resolved.manifest, resolved.schedule, records, resolved.calibration),
			executionBudget: budget
		}
	};
}

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function stopMatchRunner(child) {
	if (child == null || child.exitCode != null || child.signalCode != null) return;
	const exited = new Promise(resolveExit => child.once('exit', resolveExit));
	child.kill('SIGTERM');
	await Promise.race([exited, delay(2000)]);
	if (child.exitCode == null && child.signalCode == null) {
		child.kill('SIGKILL');
		await Promise.race([exited, delay(2000)]);
	}
}

async function invokeMatchRunner(game) {
	const child = spawn(game.invocation.executable, [game.invocation.script, ...game.invocation.args], {
		cwd: resolve(testsDirectory, '../..'),
		stdio: 'inherit'
	});
	let timedOut = false;
	const watchdog = setTimeout(() => {
		timedOut = true;
		console.error(`[benchmark-sweep] watchdog: ${game.label} exceeded its wall-clock horizon plus grace; killing it`);
		void stopMatchRunner(child);
	}, game.wallClockSafetyMinutes * 60_000 + WatchdogGraceMs);
	const result = await new Promise(resolveResult => {
		child.once('error', error => resolveResult({
			exitCode: -1,
			signal: null,
			timedOut,
			error: error.message
		}));
		child.once('exit', (exitCode, signal) => resolveResult({
			exitCode: exitCode ?? -1,
			signal: signal ?? null,
			timedOut,
			error: null
		}));
	});
	clearTimeout(watchdog);
	return result;
}

export async function estimateSweepGame(game, sidecarUrl, options = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const estimatedDecisionsPerAgent = game.decisionHorizon + 1;
	assert(Number.isSafeInteger(estimatedDecisionsPerAgent) &&
		estimatedDecisionsPerAgent >= 2 && estimatedDecisionsPerAgent <= 1000,
		`${game.label} has no finite budget-estimation horizon`);
	const input = {
		models: game.seats.map(seat => seat.modelId),
		maxOutputTokens: RawTrackMaxOutputTokens,
		estimatedInputTokens: EstimateInputTokens,
		estimatedDecisionsPerAgent,
		strategyArsenalEnabled: false
	};
	const response = await fetchImpl(`${localUrl(sidecarUrl, 'estimate sidecar URL')}/api/estimate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input),
		signal: AbortSignal.timeout(30_000)
	});
	const payload = await response.json().catch(() => ({ error: `HTTP ${response.status} returned non-JSON` }));
	if (!response.ok)
		throw new Error(`estimate preflight failed HTTP ${response.status}: ${payload.error ?? 'unknown error'}`);
	assert(Array.isArray(payload.agents) && payload.agents.length === 2,
		'estimate preflight must return exactly two agent quotes');
	let perDecisionUsd = 0;
	for (const [ordinal, agent] of payload.agents.entries()) {
		assert(agent?.model === input.models[ordinal],
			`estimate preflight seat ${ordinal + 1} model does not match the scheduled seat`);
		assert(Number.isFinite(agent.perDecisionUsd) && agent.perDecisionUsd >= 0,
			`estimate preflight seat ${ordinal + 1} has an invalid per-decision quote`);
		perDecisionUsd += agent.perDecisionUsd;
	}
	assert(Number.isFinite(payload.estimatedMatchUsd) && payload.estimatedMatchUsd >= 0,
		'estimate preflight returned an invalid match quote');
	const oneAttemptEnvelope = Math.max(payload.estimatedMatchUsd,
		perDecisionUsd * estimatedDecisionsPerAgent);
	// Every decision may consume one strict call plus one repair call. Reserving
	// both makes the between-game ceiling conservative without reintroducing a
	// dollar stop into the latency-invariant skill track.
	return oneAttemptEnvelope * MaxProviderAttemptsPerDecision;
}

async function executeSweep(resolved, options = {}) {
	assert(resolved.calibration.testOnly === false, 'real execution refuses a test-only calibration vector');
	const needsAnchor = resolved.schedule.games.some(game => game.hasAnchor);
	const proxy = needsAnchor ? createBenchmarkAnchorProxy({
		upstreamUrl: resolved.runtime.upstreamSidecarUrl,
		port: resolved.runtime.anchorProxyPort
	}) : null;
	try {
		if (proxy != null) await proxy.start();
		const result = await runResumableSweep(resolved, {
			resume: options.resume === true,
			invokeGame: invokeMatchRunner,
			estimateGame: game => estimateSweepGame(game,
				game.hasAnchor ? proxy.url : resolved.runtime.upstreamSidecarUrl)
		});
		return {
			...result,
			report: result.complete
				? {
					...aggregateSeries(resolved.manifest, resolved.schedule, result.records, resolved.calibration),
					executionBudget: result.budget
				}
				: null
		};
	} finally {
		await proxy?.stop();
	}
}

function usage() {
	console.error('Usage: node benchmark-sweep-runner.mjs --manifest <json> ' +
		'(--dry-run | --scripted-fixture --test-fixture | --score-only [--test-fixture] | ' +
		'--execute --confirm-provider-spend [--resume]) ' +
		'[--ledger <json> --match-results <dir>] [--output <json>]');
}

async function main() {
	const args = process.argv.slice(2);
	let manifestPath = null;
	let outputPath = null;
	let ledgerPath = null;
	let matchRoot = null;
	const flags = new Set();
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (['--manifest', '--output', '--ledger', '--match-results'].includes(token) && index + 1 < args.length) {
			const value = args[++index];
			if (value.startsWith('--')) throw new Error(`${token} requires a value`);
			if (token === '--manifest') manifestPath = value;
			else if (token === '--output') outputPath = value;
			else if (token === '--ledger') ledgerPath = value;
			else matchRoot = value;
		} else if (['--dry-run', '--scripted-fixture', '--test-fixture', '--execute',
			'--score-only', '--confirm-provider-spend', '--resume'].includes(token)) flags.add(token);
		else throw new Error(`unknown or incomplete argument '${token}'`);
	}
	assert(manifestPath != null, '--manifest is required');
	const modes = ['--dry-run', '--scripted-fixture', '--score-only', '--execute'].filter(flag => flags.has(flag));
	assert(modes.length === 1,
		'choose exactly one of --dry-run, --scripted-fixture, --score-only, or --execute');
	if (flags.has('--scripted-fixture'))
		assert(flags.has('--test-fixture'), '--scripted-fixture requires --test-fixture');
	if (flags.has('--test-fixture'))
		assert(!flags.has('--execute'), '--test-fixture can never execute real matches');
	if (flags.has('--execute'))
		assert(flags.has('--confirm-provider-spend'), '--execute requires --confirm-provider-spend');
	else assert(!flags.has('--confirm-provider-spend'), '--confirm-provider-spend is only valid with --execute');
	if (flags.has('--resume'))
		assert(flags.has('--execute'), '--resume is only valid with --execute');
	if (ledgerPath != null || matchRoot != null)
		assert(flags.has('--score-only'), '--ledger and --match-results are only valid with --score-only');

	const resolved = resolveSweep(manifestPath, { allowTestVector: flags.has('--test-fixture') });
	if (flags.has('--dry-run')) {
		console.log(JSON.stringify(dryRunDocument(resolved)));
		return;
	}
	const result = flags.has('--scripted-fixture') ? runScriptedSweep(resolved)
		: flags.has('--score-only') ? scoreExistingSweep(resolved, { ledgerPath, matchRoot })
			: await executeSweep(resolved, { resume: flags.has('--resume') });
	if (outputPath != null) {
		const absoluteOutput = resolve(outputPath);
		mkdirSync(dirname(absoluteOutput), { recursive: true });
		writeFileSync(absoluteOutput, `${JSON.stringify(result, null, 2)}\n`);
	}
	if (result.report != null)
		console.log(JSON.stringify(result.report));
	else {
		console.log(JSON.stringify({
			schemaVersion: 1,
			seriesId: resolved.manifest.seriesId,
			complete: false,
			ledgerPath: result.ledgerPath,
			recordedGames: result.records.length,
			pendingLabels: result.pendingLabels,
			budget: result.budget,
			stop: result.stop
		}));
		process.exitCode = 1;
	}
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main().catch(error => {
		console.error(`BENCHMARK SWEEP FAILED: ${error.message}`);
		usage();
		process.exitCode = 1;
	});
}
