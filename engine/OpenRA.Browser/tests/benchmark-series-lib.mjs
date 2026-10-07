// Deterministic schedule, scoring, confidence-interval, and anchored-Elo helpers for the
// benchmark-lockstep sweep. This module has no I/O beyond loading an explicitly named
// calibration bundle and never contacts a model provider.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	ComponentFields,
	assert,
	canonicalJson,
	evaluate,
	sha256
} from './benchmark-calibration-lib.mjs';

export const BenchmarkSeriesSpecVersion = 'benchmark-series-v1';
export const BenchmarkLockstepSpecVersion = 'benchmark-lockstep-v1';
export const AnchorRating = 1200;
export const EloRidgeScale = 800;
export const LockedWeights = Object.freeze({
	liveHpAdjustedPower: 0.25,
	structuresByValue: 0.20,
	economy: 0.20,
	unitReplacementValue: 0.15,
	tech: 0.10,
	regionControl: 0.10
});
const AssistanceFields = ['arsenal', 'executor', 'guided', 'fallbackStrike', 'play', 'staffSeat', 'lessons'];
const ModelIdentityFields = ['schemaVersion', 'agentId', 'decisionId', 'requestedModelId',
	'canonicalRequestedModelId', 'requestedRoute', 'attempts', 'valid', 'failureReason'];
const ModelIdentityAttemptFields = ['label', 'servedModelId', 'endpointHost', 'resolvedRoute', 'substitutedFor'];
const ProviderEndpointFields = ['schemaVersion', 'resolvedUrl', 'endpointHost', 'loopback'];

function finiteNumber(value, label, minimum = -Infinity) {
	assert(Number.isFinite(value) && value >= minimum, `${label} must be a finite number >= ${minimum}`);
	return value;
}

function safeInteger(value, label, minimum = 0) {
	assert(Number.isSafeInteger(value) && value >= minimum, `${label} must be a safe integer >= ${minimum}`);
	return value;
}

function signedSafeInteger(value, label) {
	assert(Number.isSafeInteger(value), `${label} must be a safe integer`);
	return value;
}

function exactKeys(value, expected, label) {
	assert(value != null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
	assert(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()),
		`${label} fields must be exactly ${[...expected].sort().join(',')}`);
}

export function canonicalModelId(modelId) {
	assert(typeof modelId === 'string' && modelId.length > 0 && modelId.length <= 200,
		'model id must be a non-empty string no longer than 200 characters');
	const match = /^([A-Za-z0-9._-]+):(.+)$/.exec(modelId);
	return match == null ? modelId : match[2];
}

function isLoopbackHostname(hostname) {
	return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname.toLowerCase());
}

export function validateProviderEndpointProvenance(outcome, label = 'provider endpoint') {
	const record = outcome?.providerEndpoint;
	exactKeys(record, ProviderEndpointFields, label);
	assert(record.schemaVersion === 1, `${label} schemaVersion must be 1`);
	assert(record.loopback === true, `${label} must be recorded as loopback`);
	assert(typeof record.resolvedUrl === 'string' && record.resolvedUrl.length > 0,
		`${label} resolved URL is missing`);
	let endpoint;
	try {
		endpoint = new URL(record.resolvedUrl);
	} catch {
		assert(false, `${label} resolved URL is invalid`);
	}
	assert(['http:', 'https:'].includes(endpoint.protocol) && isLoopbackHostname(endpoint.hostname) &&
		endpoint.username === '' && endpoint.password === '',
		`${label} '${record.resolvedUrl}' is not an unauthenticated loopback HTTP endpoint`);
	assert(record.endpointHost === endpoint.host.toLowerCase(),
		`${label} host does not match its resolved URL`);
	return record;
}

export function validateDecisionModelIdentity(record, expected, label = 'model identity') {
	exactKeys(record, ModelIdentityFields, label);
	assert(record.schemaVersion === 1, `${label} schemaVersion must be 1`);
	assert(typeof expected?.agentId === 'string' && record.agentId === expected.agentId,
		`${label} agentId does not match the recorded request`);
	assert(Number.isSafeInteger(expected?.decisionId) && record.decisionId === expected.decisionId,
		`${label} decisionId does not match the recorded request`);
	assert(record.requestedModelId === expected.modelId,
		`${label} requested model does not match the recorded request`);
	const expectedCanonical = canonicalModelId(expected.modelId);
	assert(record.canonicalRequestedModelId === expectedCanonical,
		`${label} canonical requested model is invalid`);
	const routeMatch = /^([A-Za-z0-9._-]+):(.+)$/.exec(expected.modelId);
	assert(record.requestedRoute === (routeMatch?.[1] ?? null),
		`${label} requested route does not match the recorded request`);
	assert(record.valid === true && record.failureReason === null,
		`${label} reports an invalid or substituted provider answer`);
	assert(Array.isArray(record.attempts) && record.attempts.length >= 1 && record.attempts.length <= 2,
		`${label} must carry one or two provider attempts`);
	for (const [index, attempt] of record.attempts.entries()) {
		exactKeys(attempt, ModelIdentityAttemptFields, `${label} attempt ${index}`);
		assert(typeof attempt.label === 'string' && attempt.label.length > 0,
			`${label} attempt ${index} label is missing`);
		assert(canonicalModelId(attempt.servedModelId) === expectedCanonical,
			`${label} attempt ${index} served a different model`);
		assert(typeof attempt.endpointHost === 'string' && attempt.endpointHost.length > 0 &&
			attempt.endpointHost.length <= 255 && !/[/\\@\s]/.test(attempt.endpointHost),
			`${label} attempt ${index} endpoint host is missing or unsafe`);
		assert(typeof attempt.resolvedRoute === 'string' && attempt.resolvedRoute.length > 0 &&
			attempt.resolvedRoute.length <= 255 && !/[/\\@\s]/.test(attempt.resolvedRoute),
			`${label} attempt ${index} resolved route is missing or unsafe`);
		assert(attempt.substitutedFor === null,
			`${label} attempt ${index} substituted another model`);
		if (expected.endpointHost != null) {
			assert(attempt.endpointHost === expected.endpointHost,
				`${label} attempt ${index} endpoint does not match the sidecar preflight`);
		}
		if (expected.scriptedAnchor === true) {
			assert(attempt.resolvedRoute === 'scripted-anchor',
				`${label} attempt ${index} did not use the versioned scripted-anchor route`);
		}
	}
	return record;
}

export function validateOutcomeModelIdentity(game, outcome) {
	const providerEndpoint = validateProviderEndpointProvenance(
		outcome, `${game.gameId} provider endpoint`);
	assert(outcome?.modelIdentity?.schemaVersion === 1 &&
		Array.isArray(outcome.modelIdentity.records),
		`${game.gameId} has no complete model-identity provenance`);
	const agents = outcome.lastAgentsSnapshot?.agents;
	assert(Array.isArray(agents) && agents.length === 2 &&
		agents.every(agent => typeof agent?.agentId === 'string' && agent.agentId.length > 0),
		`${game.gameId} cannot bind model identity to both benchmark seats`);
	const records = outcome.modelIdentity.records;
	const recordsByKey = new Map();
	for (const record of records) {
		const key = `${record?.agentId}:${record?.decisionId}`;
		assert(!recordsByKey.has(key), `${game.gameId} has duplicate model identity for ${key}`);
		recordsByKey.set(key, record);
	}

	const expectedKeys = new Set();
	for (const barrier of outcome.benchmark?.barrierTrace ?? []) {
		for (const seat of barrier.seats ?? []) {
			if (seat.status !== 'valid')
				continue;
			const ordinal = seat.ordinal;
			assert(ordinal === 0 || ordinal === 1,
				`${game.gameId} model identity saw an invalid seat ordinal`);
			const expected = {
				agentId: agents[ordinal].agentId,
				decisionId: seat.decisionId,
				modelId: game.seats[ordinal].modelId,
				endpointHost: game.seats[ordinal].anchor ? null : providerEndpoint.endpointHost,
				scriptedAnchor: game.seats[ordinal].anchor === true
			};
			const key = `${expected.agentId}:${expected.decisionId}`;
			assert(!expectedKeys.has(key), `${game.gameId} barrier trace repeats ${key}`);
			expectedKeys.add(key);
			assert(recordsByKey.has(key), `${game.gameId} is missing model identity for ${key}`);
			validateDecisionModelIdentity(recordsByKey.get(key), expected, `${game.gameId} ${key}`);
		}
	}
	assert(records.length === expectedKeys.size,
		`${game.gameId} model identity contains a decision absent from the accepted barrier trace`);
	return records;
}

function controlRegionHash(regions) {
	const canonical = regions.map(region =>
		`${region.id}:${region.cells.map(cell => `${cell.x},${cell.y}`).join(';')}`).join('|');
	return sha256(canonical);
}

export function validateCalibrationBundle(bundle, options = {}) {
	const allowTestVector = options.allowTestVector === true;
	assert(bundle?.schemaVersion === 1, 'calibration schemaVersion must be 1');
	assert(bundle.specVersion === BenchmarkLockstepSpecVersion,
		`calibration specVersion must be ${BenchmarkLockstepSpecVersion}`);
	if (allowTestVector) {
		assert(bundle.status === 'frozen-test-vector' && bundle.scope === 'golden-score-gate-only' &&
			bundle.productionDefault === false,
			'test calibration must remain the explicitly scoped non-production golden vector');
	} else {
		assert(bundle.status === 'frozen',
			'leaderboard calibration must have status=frozen (candidate and test vectors are forbidden)');
	}

	const weights = bundle.weights ?? bundle.lockedScoring?.weights;
	const drawBand = bundle.drawBand ?? bundle.lockedScoring?.drawBand;
	const floors = bundle.floors ?? bundle.frozenFloors?.values;
	const map = bundle.map ?? null;
	const regions = map?.regions ?? bundle.regions;
	const regionHash = map?.controlRegionHash ?? bundle.controlRegionHash;
	const mapId = map?.mapId ?? bundle.mapId ?? null;
	exactKeys(weights, ComponentFields, 'calibration weights');
	exactKeys(floors, ComponentFields, 'calibration floors');
	for (const field of ComponentFields) {
		finiteNumber(weights[field], `calibration weight ${field}`, 0);
		finiteNumber(floors[field], `calibration floor ${field}`, Number.MIN_VALUE);
		assert(weights[field] === LockedWeights[field],
			`calibration weight ${field} drifted from the locked benchmark spec`);
	}
	assert(Object.values(weights).reduce((sum, weight) => sum + weight, 0) === 1,
		'calibration weights must sum exactly to 1');
	assert(drawBand === 0.10, 'calibration drawBand must equal the locked 0.10 boundary');
	assert(Array.isArray(regions) && regions.length > 0 && regions.length <= 64,
		'calibration must freeze 1-64 control regions');
	const seenRegionIds = new Set();
	const seenCells = new Set();
	for (const region of regions) {
		assert(typeof region.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(region.id) &&
			!seenRegionIds.has(region.id), `invalid or duplicate control region id '${region.id}'`);
		seenRegionIds.add(region.id);
		assert(Array.isArray(region.cells) && region.cells.length > 0,
			`control region ${region.id} must contain cells`);
		for (const cell of region.cells) {
			signedSafeInteger(cell.x, `${region.id} cell x`);
			signedSafeInteger(cell.y, `${region.id} cell y`);
			const key = `${cell.x},${cell.y}`;
			assert(!seenCells.has(key), `control-region cell ${key} is assigned more than once`);
			seenCells.add(key);
		}
	}
	assert(seenCells.size <= 4096, 'calibration control regions exceed the host 4096-cell limit');
	assert(controlRegionHash(regions) === regionHash, 'calibration controlRegionHash does not match exact cells');
	if (!allowTestVector) {
		assert(typeof mapId === 'string' && mapId.length > 0,
			'frozen leaderboard calibration must pin mapId');
		assert(mapId === options.mapId,
			`calibration mapId '${mapId}' does not match requested benchmark map '${options.mapId}'`);
	}

	return {
		calibrationId: bundle.calibrationId,
		status: bundle.status,
		specVersion: bundle.specVersion,
		mapId: mapId ?? options.mapId,
		weights: structuredClone(weights),
		drawBand,
		floors: structuredClone(floors),
		regions: structuredClone(regions),
		controlRegionHash: regionHash,
		digest: sha256(canonicalJson(bundle)),
		testOnly: allowTestVector
	};
}

export function loadCalibrationBundle(calibrationPath, options = {}) {
	const absolutePath = resolve(calibrationPath);
	let bundle;
	try {
		bundle = JSON.parse(readFileSync(absolutePath, 'utf8'));
	} catch (error) {
		throw new Error(`cannot read calibration '${absolutePath}': ${error.message}`);
	}
	return { path: absolutePath, bundle, normalized: validateCalibrationBundle(bundle, options) };
}

export function loadEraLockIdentity(eraLockPath) {
	const absolutePath = resolve(eraLockPath);
	let lock;
	try {
		lock = JSON.parse(readFileSync(absolutePath, 'utf8'));
	} catch (error) {
		throw new Error(`cannot read era lock '${absolutePath}': ${error.message}`);
	}

	exactKeys(lock, ['schemaVersion', 'era', 'engineCommit', 'files', 'doctrineHashes', 'lockHash'], 'era lock');
	assert(lock.schemaVersion === 1, 'era lock schemaVersion must be 1');
	assert(typeof lock.era === 'string' && /^[A-Za-z0-9._-]+$/.test(lock.era),
		'era lock era must be a filesystem-safe label');
	assert(typeof lock.engineCommit === 'string' && /^[0-9a-f]{40}$/.test(lock.engineCommit),
		'era lock engineCommit must be a 40-hex commit id');
	assert(lock.files != null && typeof lock.files === 'object' && !Array.isArray(lock.files),
		'era lock files must be an object');
	assert(lock.doctrineHashes != null && typeof lock.doctrineHashes === 'object' &&
		!Array.isArray(lock.doctrineHashes), 'era lock doctrineHashes must be an object');
	assert(typeof lock.lockHash === 'string' && /^[0-9a-f]{64}$/.test(lock.lockHash),
		'era lock lockHash must be a sha256 hex value');
	const { lockHash, ...body } = lock;
	assert(sha256(canonicalJson(body)) === lockHash, 'era lock lockHash does not match its canonical body');

	return {
		path: absolutePath,
		bundle: lock,
		normalized: {
			schemaVersion: lock.schemaVersion,
			era: lock.era,
			engineCommit: lock.engineCommit,
			lockHash: lock.lockHash
		}
	};
}

function slug(value) {
	return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function validateModel(model, index) {
	assert(model != null && typeof model === 'object', `models[${index}] must be an object`);
	assert(typeof model.id === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(model.id),
		`models[${index}].id is invalid`);
	assert(model.reasoningEffort == null || ['low', 'medium', 'high'].includes(model.reasoningEffort),
		`models[${index}].reasoningEffort is invalid`);
	return {
		id: model.id,
		label: model.label ?? model.id,
		reasoningEffort: model.reasoningEffort ?? null,
		anchor: model.anchor === true
	};
}

export function buildPairedSchedule(manifest, options = {}) {
	assert(manifest?.schemaVersion === 1, 'sweep manifest schemaVersion must be 1');
	assert(manifest.seriesSpecVersion === BenchmarkSeriesSpecVersion,
		`seriesSpecVersion must be ${BenchmarkSeriesSpecVersion}`);
	assert(manifest.benchmarkSpecVersion === BenchmarkLockstepSpecVersion,
		`benchmarkSpecVersion must be ${BenchmarkLockstepSpecVersion}`);
	assert(typeof manifest.seriesId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(manifest.seriesId),
		'seriesId must be filesystem-safe');
	assert(typeof manifest.map === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(manifest.map),
		'manifest map must be an explicit map uid');
	if (Object.prototype.hasOwnProperty.call(manifest, 'eraLock'))
		assert(typeof manifest.eraLock === 'string' && manifest.eraLock.length > 0,
			'manifest eraLock must be a non-empty path when present');
	safeInteger(manifest.pairCount, 'pairCount', 3);
	assert(Array.isArray(manifest.seeds) && manifest.seeds.length === manifest.pairCount,
		'seeds must contain exactly pairCount values');
	const seeds = manifest.seeds.map((seed, index) => safeInteger(seed, `seeds[${index}]`, 1));
	assert(new Set(seeds).size === seeds.length, 'pair seeds must be unique');
	assert(Array.isArray(manifest.factionCycle) && manifest.factionCycle.length > 0,
		'factionCycle must contain at least one faction pairing');
	for (const [index, factions] of manifest.factionCycle.entries()) {
		assert(Array.isArray(factions) && factions.length === 2 && factions.every(faction =>
			typeof faction === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(faction)),
			`factionCycle[${index}] must contain two faction ids`);
	}
	safeInteger(manifest.tickHorizon, 'tickHorizon');
	safeInteger(manifest.decisionHorizon, 'decisionHorizon');
	assert(manifest.tickHorizon > 0 || manifest.decisionHorizon > 0,
		'a tick or decision horizon is required');
	safeInteger(manifest.decisionTimeoutMs, 'decisionTimeoutMs', 10_000);
	assert(manifest.decisionTimeoutMs <= 120_000, 'decisionTimeoutMs exceeds the host maximum');
	safeInteger(manifest.decisionIntervalTicks, 'decisionIntervalTicks', 25);
	assert(manifest.decisionIntervalTicks <= 2500,
		'decisionIntervalTicks exceeds the host maximum');
	finiteNumber(manifest.wallClockSafetyMinutes, 'wallClockSafetyMinutes', Number.MIN_VALUE);
	assert(manifest.dollarStop == null || manifest.dollarStop === false,
		'dollarStop is forbidden for benchmark skill sweeps');

	assert(Array.isArray(manifest.models) && manifest.models.length >= 3,
		'model pool must contain at least two candidates plus the fixed anchor');
	const models = manifest.models.map(validateModel);
	assert(new Set(models.map(model => model.id)).size === models.length, 'model ids must be unique');
	const anchors = models.filter(model => model.anchor);
	assert(anchors.length === 1, 'model pool must contain exactly one fixed anchor');
	assert(anchors[0].id === manifest.anchor?.modelId, 'anchor.modelId must identify the anchor model entry');
	assert(manifest.anchor?.rating === AnchorRating,
		`anchor rating must be the arbitrary ${AnchorRating} scale origin`);
	assert(manifest.anchor?.difficulty === options.anchorSpec?.difficulty,
		'anchor difficulty does not match the scripted policy');
	assert(manifest.anchor?.policyVersion === options.anchorSpec?.policyVersion,
		'anchor policyVersion does not match the scripted policy');
	assert(manifest.anchor?.policyDigest === options.anchorSpec?.policyDigest,
		'anchor policyDigest does not match the scripted policy');
	assert((options.eraLockPath == null) === (options.eraLock == null),
		'resolved era lock path and identity must be supplied together');

	const games = [];
	let scheduleIndex = 0;
	for (let left = 0; left < models.length; left++) {
		for (let right = left + 1; right < models.length; right++) {
			const matchupId = `${slug(models[left].id)}--vs--${slug(models[right].id)}`;
			for (let pairIndex = 0; pairIndex < manifest.pairCount; pairIndex++) {
				const pairId = `${matchupId}--pair-${pairIndex + 1}`;
				const factions = manifest.factionCycle[pairIndex % manifest.factionCycle.length];
				for (let leg = 0; leg < 2; leg++) {
					const seats = leg === 0 ? [models[left], models[right]] : [models[right], models[left]];
					games.push({
						scheduleIndex: scheduleIndex++,
						gameId: `${pairId}--leg-${leg + 1}`,
						label: `${slug(manifest.seriesId)}-${String(scheduleIndex).padStart(3, '0')}`,
						matchupId,
						pairId,
						pairIndex,
						leg: leg + 1,
						seed: seeds[pairIndex],
						map: manifest.map,
						calibrationPath: options.calibrationPath,
						eraLockPath: options.eraLockPath ?? null,
						eraLock: options.eraLock == null ? null : structuredClone(options.eraLock),
						canonicalModels: [models[left].id, models[right].id],
						seats: seats.map((model, ordinal) => ({
							ordinal,
							seat: `agent${ordinal + 1}`,
							spawnSlot: ordinal + 1,
							modelId: model.id,
							anchor: model.anchor,
							faction: factions[ordinal],
							reasoningEffort: model.reasoningEffort
						})),
						tickHorizon: manifest.tickHorizon,
						decisionHorizon: manifest.decisionHorizon,
						decisionTimeoutMs: manifest.decisionTimeoutMs,
						decisionIntervalTicks: manifest.decisionIntervalTicks,
						wallClockSafetyMinutes: manifest.wallClockSafetyMinutes
					});
				}
			}
		}
	}

	return {
		models,
		anchor: anchors[0],
		eraLock: options.eraLock == null ? null : structuredClone(options.eraLock),
		games
	};
}

export function matchRunnerArgs(game, runtime) {
	const args = [
		'--model1', game.seats[0].modelId,
		'--model2', game.seats[1].modelId,
		'--faction1', game.seats[0].faction,
		'--faction2', game.seats[1].faction,
		'--label', game.label,
		'--minutes', String(game.wallClockSafetyMinutes),
		'--port', String(runtime.port),
		'--sidecar', runtime.sidecarUrl,
		'--seed', String(game.seed),
		'--map', game.map,
		'--benchmark-calibration', game.calibrationPath,
		'--benchmark-lockstep',
		'--tick-horizon', String(game.tickHorizon),
		'--decision-horizon', String(game.decisionHorizon),
		'--decision-timeout-ms', String(game.decisionTimeoutMs)
	];
	if (game.eraLockPath != null) args.push('--era-lock', game.eraLockPath);
	if (game.seats[0].reasoningEffort) args.push('--effort1', game.seats[0].reasoningEffort);
	if (game.seats[1].reasoningEffort) args.push('--effort2', game.seats[1].reasoningEffort);
	assert(!args.includes('--cap'), 'benchmark invocation must never contain a dollar stop');
	return args;
}

function terminalOutcome(winner) {
	if (winner == null) return 'Unresolved';
	if (winner === 'agent1') return 'SideAWin';
	if (winner === 'agent2') return 'SideBWin';
	throw new Error(`unknown benchmark winner seat '${winner}'`);
}

function seatOperations(outcome, ordinal) {
	const agent = outcome.lastAgentsSnapshot?.agents?.[ordinal] ?? {};
	const durations = [];
	let noOpBarriers = 0;
	for (const barrier of outcome.benchmark?.barrierTrace ?? []) {
		const seat = barrier.seats?.find(candidate => candidate.ordinal === ordinal);
		if (seat == null || seat.decisionId === 0) continue;
		if (Number.isFinite(seat.durationMs)) durations.push(seat.durationMs);
		if (seat.status !== 'valid') noOpBarriers++;
	}
	return {
		latencyMs: durations,
		spendUsd: outcome.perSeatSpendUsd?.[`agent${ordinal + 1}`] ?? agent.spentUsd ?? 0,
		fallbackTurns: agent.fallbackTurns ?? 0,
		decisionOpportunities: agent.decisionOpportunities ?? durations.length,
		noOpBarriers
	};
}

export function scoreGame(game, outcome, calibration) {
	assert(outcome?.infrastructureCensored !== true,
		`${game.gameId} is infrastructure-censored and cannot enter the skill table`);
	exactKeys(outcome?.assistance, AssistanceFields, `${game.gameId} assistance`);
	assert(AssistanceFields.every(field => outcome.assistance[field] === false),
		`${game.gameId} used host assistance and cannot enter the raw skill table`);
	assert(outcome.lessonsMode === 'off',
		`${game.gameId} lessonsMode must be off for the raw skill table`);
	assert(outcome?.benchmark?.enabled === true && outcome.benchmark.specVersion === BenchmarkLockstepSpecVersion,
		`${game.gameId} is not a ${BenchmarkLockstepSpecVersion} outcome`);
	assert(outcome.benchmark.oos === false, `${game.gameId} reported oos=true`);
	validateOutcomeModelIdentity(game, outcome);
	assert(outcome.benchmark.requestedMapUid === game.map,
		`${game.gameId} outcome map does not match the paired schedule`);
	assert(outcome.benchmark.decisionIntervalTicks === game.decisionIntervalTicks,
		`${game.gameId} host-used decision interval does not match the sweep manifest`);
	assert(outcome.benchmark.calibration?.digest === calibration.digest &&
		outcome.benchmark.calibration?.controlRegionHash === calibration.controlRegionHash &&
		outcome.benchmark.calibration?.mapId === calibration.mapId,
		`${game.gameId} outcome was not produced with the frozen calibration being scored`);
	if (game.eraLock == null)
		assert(outcome.eraLock == null, `${game.gameId} outcome carries an era lock absent from the schedule`);
	else
		assert(outcome.eraLock?.schemaVersion === game.eraLock.schemaVersion &&
			outcome.eraLock?.era === game.eraLock.era &&
			outcome.eraLock?.engineCommit === game.eraLock.engineCommit &&
			outcome.eraLock?.lockHash === game.eraLock.lockHash,
		`${game.gameId} outcome era lock does not match the paired schedule`);
	const telemetry = outcome.benchmark.adjudication;
	assert(Array.isArray(telemetry?.seats) && telemetry.seats.length === 2,
		`${game.gameId} has no complete adjudication ledger`);
	assert(telemetry.controlRegionCount === calibration.regions.length,
		`${game.gameId} control-region count does not match its frozen calibration`);
	const ledgerSeats = [...telemetry.seats].sort((a, b) => a.ordinal - b.ordinal);
	assert(ledgerSeats[0].ordinal === 0 && ledgerSeats[1].ordinal === 1,
		`${game.gameId} adjudication ledger is not seat-complete`);
	const scored = evaluate(ledgerSeats[0].components, ledgerSeats[1].components, calibration.floors,
		terminalOutcome(outcome.winner), calibration.weights, calibration.drawBand);
	const seatScores = [scored.score, -scored.score];
	return {
		gameId: game.gameId,
		scheduleIndex: game.scheduleIndex,
		matchupId: game.matchupId,
		pairId: game.pairId,
		pairIndex: game.pairIndex,
		leg: game.leg,
		seed: game.seed,
		map: game.map,
		winner: outcome.winner ?? null,
		terminalOverride: scored.terminalOverride,
		verdict: scored.verdict,
		oos: false,
		seats: game.seats.map((seat, ordinal) => ({
			...seat,
			score: seatScores[ordinal],
			result: scored.verdict === 'Draw' ? 'draw'
				: (ordinal === 0) === (scored.verdict === 'SideA') ? 'win' : 'loss',
			components: structuredClone(ledgerSeats[ordinal].components),
			operations: seatOperations(outcome, ordinal)
		}))
	};
}

function mean(values) {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = (sorted.length - 1) * fraction;
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

const StudentT95 = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
	2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
	2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

export function clusteredMeanConfidence(pairMeans) {
	assert(pairMeans.length >= 3, 'a confidence interval requires at least three independent seed pairs');
	const average = mean(pairMeans);
	const variance = pairMeans.reduce((sum, value) => sum + (value - average) ** 2, 0) /
		(pairMeans.length - 1);
	const critical = StudentT95[pairMeans.length - 1] ?? 1.96;
	const radius = critical * Math.sqrt(variance / pairMeans.length);
	return { mean: average, lower: Math.max(-1, average - radius), upper: Math.min(1, average + radius),
		radius, clusterCount: pairMeans.length, method: 'two-sided-95pct-student-t-by-seed-pair' };
}

function expectedScore(ratingA, ratingB) {
	return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

function solveLinearSystem(matrix, vector) {
	const size = vector.length;
	const augmented = matrix.map((row, index) => [...row, vector[index]]);
	for (let column = 0; column < size; column++) {
		let pivot = column;
		for (let row = column + 1; row < size; row++)
			if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
		assert(Math.abs(augmented[pivot][column]) > 1e-15, 'anchored Elo information matrix is singular');
		[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
		for (let row = column + 1; row < size; row++) {
			const factor = augmented[row][column] / augmented[column][column];
			for (let index = column; index <= size; index++)
				augmented[row][index] -= factor * augmented[column][index];
		}
	}
	const result = Array(size).fill(0);
	for (let row = size - 1; row >= 0; row--) {
		let remaining = augmented[row][size];
		for (let column = row + 1; column < size; column++)
			remaining -= augmented[row][column] * result[column];
		result[row] = remaining / augmented[row][row];
	}
	return result;
}

export function anchoredElo(records, modelIds, anchorId, ridgeScale = EloRidgeScale) {
	assert(modelIds.includes(anchorId), 'anchor is missing from the Elo model pool');
	assert(ridgeScale > 0, 'anchored Elo ridgeScale must be positive');
	const ratings = Object.fromEntries(modelIds.map(modelId => [modelId, AnchorRating]));
	const fitted = modelIds.filter(modelId => modelId !== anchorId);
	const ordinal = new Map(fitted.map((modelId, index) => [modelId, index]));
	const logisticScale = Math.log(10) / 400;
	const ridge = 1 / ridgeScale ** 2;
	const ordered = [...records].sort((a, b) => a.gameId.localeCompare(b.gameId));
	for (let iteration = 0; iteration < 100; iteration++) {
		const gradient = fitted.map(modelId => -ridge * (ratings[modelId] - AnchorRating));
		const information = fitted.map((modelId, row) =>
			fitted.map((other, column) => row === column ? ridge : 0));
		for (const record of ordered) {
			const [seatA, seatB] = record.seats;
			const actualA = (seatA.score + 1) / 2;
			const probabilityA = expectedScore(ratings[seatA.modelId], ratings[seatB.modelId]);
			const slope = logisticScale * (actualA - probabilityA);
			const curvature = logisticScale ** 2 * probabilityA * (1 - probabilityA);
			const indexA = ordinal.get(seatA.modelId);
			const indexB = ordinal.get(seatB.modelId);
			if (indexA != null) {
				gradient[indexA] += slope;
				information[indexA][indexA] += curvature;
			}
			if (indexB != null) {
				gradient[indexB] -= slope;
				information[indexB][indexB] += curvature;
			}
			if (indexA != null && indexB != null) {
				information[indexA][indexB] -= curvature;
				information[indexB][indexA] -= curvature;
			}
		}
		const delta = solveLinearSystem(information, gradient);
		for (let index = 0; index < fitted.length; index++)
			ratings[fitted[index]] += Math.max(-400, Math.min(400, delta[index]));
		ratings[anchorId] = AnchorRating;
		if (Math.max(...delta.map(Math.abs)) < 1e-9) break;
	}
	return ratings;
}

function prng(seed) {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

export function anchoredEloConfidence(records, modelIds, anchorId, iterations = 500, seed = 0x0B3E11A) {
	const point = anchoredElo(records, modelIds, anchorId);
	const matchupPairs = new Map();
	for (const record of records) {
		const key = record.matchupId;
		if (!matchupPairs.has(key)) matchupPairs.set(key, new Map());
		const pairs = matchupPairs.get(key);
		if (!pairs.has(record.pairId)) pairs.set(record.pairId, []);
		pairs.get(record.pairId).push(record);
	}
	for (const pairs of matchupPairs.values())
		for (const legs of pairs.values())
			assert(legs.length === 2, 'Elo bootstrap requires complete two-leg seed pairs');
	const random = prng(seed);
	const samples = Object.fromEntries(modelIds.map(modelId => [modelId, []]));
	for (let iteration = 0; iteration < iterations; iteration++) {
		const resampled = [];
		let scheduleIndex = 0;
		for (const pairs of matchupPairs.values()) {
			const clusters = [...pairs.values()];
			for (let draw = 0; draw < clusters.length; draw++) {
				const selected = clusters[Math.floor(random() * clusters.length)];
				for (const record of [...selected].sort((a, b) => a.leg - b.leg))
					resampled.push({ ...record, scheduleIndex: scheduleIndex++ });
			}
		}
		const rating = anchoredElo(resampled, modelIds, anchorId);
		for (const modelId of modelIds) samples[modelId].push(rating[modelId]);
	}
	return Object.fromEntries(modelIds.map(modelId => [modelId, {
		rating: point[modelId],
		lower: modelId === anchorId ? AnchorRating : percentile(samples[modelId], 0.025),
		upper: modelId === anchorId ? AnchorRating : percentile(samples[modelId], 0.975),
		method: modelId === anchorId ? 'fixed-scale-origin' :
			`anchored-batch-logistic-elo-ridge-${EloRidgeScale}-paired-cluster-bootstrap-${iterations}`
	}]));
}

function summarizeOperations(seatRows) {
	const latencies = seatRows.flatMap(seat => seat.operations.latencyMs);
	const opportunities = seatRows.reduce((sum, seat) => sum + seat.operations.decisionOpportunities, 0);
	const fallbacks = seatRows.reduce((sum, seat) => sum + seat.operations.fallbackTurns, 0);
	return {
		latencyMs: { mean: mean(latencies), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
		spendUsd: seatRows.reduce((sum, seat) => sum + seat.operations.spendUsd, 0),
		fallbackTurns: fallbacks,
		decisionOpportunities: opportunities,
		fallbackRate: opportunities === 0 ? 0 : fallbacks / opportunities,
		noOpBarriers: seatRows.reduce((sum, seat) => sum + seat.operations.noOpBarriers, 0)
	};
}

export function aggregateSeries(manifest, schedule, records, calibration) {
	assert(records.length === schedule.games.length, 'series is incomplete; every scheduled game is required');
	const byGame = new Map(records.map(record => [record.gameId, record]));
	assert(byGame.size === records.length && schedule.games.every(game => byGame.has(game.gameId)),
		'series results do not match the resolved schedule');
	const matchups = [];
	for (const matchupId of [...new Set(records.map(record => record.matchupId))]) {
		const rows = records.filter(record => record.matchupId === matchupId);
		const modelA = schedule.games.find(game => game.matchupId === matchupId).canonicalModels[0];
		const modelB = schedule.games.find(game => game.matchupId === matchupId).canonicalModels[1];
		const pairMeans = [];
		for (const pairId of [...new Set(rows.map(row => row.pairId))]) {
			const legs = rows.filter(row => row.pairId === pairId);
			assert(legs.length === 2, `${pairId} must contain both seat/spawn-swapped legs`);
			pairMeans.push(mean(legs.map(row => row.seats.find(seat => seat.modelId === modelA).score)));
		}
		const modelARows = rows.map(row => row.seats.find(seat => seat.modelId === modelA));
		const wdl = {
			wins: modelARows.filter(row => row.result === 'win').length,
			draws: modelARows.filter(row => row.result === 'draw').length,
			losses: modelARows.filter(row => row.result === 'loss').length
		};
		matchups.push({ matchupId, modelA, modelB, games: rows.length, pairs: pairMeans.length, wdl,
			score: clusteredMeanConfidence(pairMeans) });
	}

	const modelIds = schedule.models.map(model => model.id);
	const elo = anchoredEloConfidence(records, modelIds, schedule.anchor.id);
	const models = modelIds.map(modelId => {
		const modelConfig = schedule.models.find(model => model.id === modelId);
		const seatRows = records.flatMap(record => record.seats.filter(seat => seat.modelId === modelId));
		const componentVector = Object.fromEntries(ComponentFields.map(field =>
			[field, mean(seatRows.map(seat => seat.components[field]))]));
		return {
			modelId,
			label: modelConfig.label,
			reasoningEffort: modelConfig.reasoningEffort ?? 'provider-default',
			anchor: modelId === schedule.anchor.id,
			skillElo: elo[modelId],
			wdl: {
				wins: seatRows.filter(row => row.result === 'win').length,
				draws: seatRows.filter(row => row.result === 'draw').length,
				losses: seatRows.filter(row => row.result === 'loss').length
			},
			meanScore: mean(seatRows.map(row => row.score)),
			components: componentVector,
			operations: summarizeOperations(seatRows)
		};
	});

	return {
		schemaVersion: 1,
		seriesSpecVersion: BenchmarkSeriesSpecVersion,
		benchmarkSpecVersion: BenchmarkLockstepSpecVersion,
		seriesId: manifest.seriesId,
		manifestDigest: sha256(canonicalJson(manifest)),
		map: manifest.map,
		eraLock: schedule.eraLock == null ? null : structuredClone(schedule.eraLock),
		calibration: {
			calibrationId: calibration.calibrationId,
			digest: calibration.digest,
			controlRegionHash: calibration.controlRegionHash,
			testOnly: calibration.testOnly
		},
		pairCount: manifest.pairCount,
		gameCount: records.length,
		design: {
			seeds: [...manifest.seeds],
			factionCycle: structuredClone(manifest.factionCycle),
			tickHorizon: manifest.tickHorizon,
			decisionHorizon: manifest.decisionHorizon,
			decisionTimeoutMs: manifest.decisionTimeoutMs,
			decisionIntervalTicks: manifest.decisionIntervalTicks,
			dollarStop: false
		},
		anchor: {
			modelId: schedule.anchor.id,
			difficulty: manifest.anchor.difficulty,
			policyVersion: manifest.anchor.policyVersion,
			policyDigest: manifest.anchor.policyDigest,
			rating: AnchorRating,
			scaleMeaning: 'arbitrary fixed origin; anchor strength is not intrinsically 1200-skill'
		},
		matchups,
		models
	};
}
