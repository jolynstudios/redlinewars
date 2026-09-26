// Increment-d no-spend gate: schedule/swap math, frozen calibration guardrails, paired
// statistics, anchored Elo, operational-column separation, and the loopback scripted anchor.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBenchmarkAnchorProxy } from './benchmark-anchor-proxy.mjs';
import {
	BenchmarkAnchorModelId,
	BenchmarkAnchorPolicyDigest,
	BenchmarkAnchorPolicyDescriptor,
	BenchmarkAnchorSpec,
	benchmarkAnchorPolicyDigest,
	scriptedAnchorDecision
} from './benchmark-scripted-anchor.mjs';
import { ComponentFields, canonicalJson } from './benchmark-calibration-lib.mjs';
import { resolveSweep, runScriptedSweep, scriptedOutcome } from './benchmark-sweep-runner.mjs';
import { anchoredElo, scoreGame } from './benchmark-series-lib.mjs';
import { AgentActionBatchSchema, PlanningBatchSchema } from '../agent-sidecar/dist/contracts.js';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testsDirectory, '../..');
const fixturePath = resolve(testsDirectory, 'benchmark-sweep/benchmark-sweep-v1.fixture.json');
const sweepRunnerPath = resolve(testsDirectory, 'benchmark-sweep-runner.mjs');
const matchRunnerPath = resolve(testsDirectory, 'match-runner.mjs');
const eraLockPath = resolve(testsDirectory, 'era-lock.mjs');
const browserIndexPath = resolve(repositoryRoot, 'OpenRA.Browser/wwwroot/index.html');
const frozenTestPath = resolve(testsDirectory, 'benchmark-calibration/golden-score-v1.frozen-test.json');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'openra-benchmark-sweep-gate-'));
const ExpectedAnchorPolicyDigest = '0669c055a2b6c0224df494ac8951662235fcc2c39b558e9f2121403eba1b3de7';

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function runNode(args, expectedStatus = 0) {
	const run = spawnSync(process.execPath, args, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024
	});
	assert(run.status === expectedStatus,
		`node ${args.join(' ')} exited ${run.status}:\n${run.stdout}\n${run.stderr}`);
	return run;
}

async function freePort() {
	const server = createServer();
	await new Promise((resolveListen, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	const selected = server.address().port;
	await new Promise(resolveClose => server.close(resolveClose));
	return selected;
}

async function readJson(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, value) {
	response.writeHead(200, { 'Content-Type': 'application/json' });
	response.end(JSON.stringify(value));
}

async function proxyGate() {
	let forwardedDecisions = 0;
	const upstream = createServer(async (request, response) => {
		const input = await readJson(request);
		if (request.url === '/api/estimate') {
			const agents = input.models.map(model => ({ model, prompt: 0.001, completion: 0.002, request: 0,
				perDecisionUsd: 0.03, estimatedInputTokens: input.estimatedInputTokens }));
			sendJson(response, { agents, estimatedMatchUsd: 1.2, assumptions: input,
				knowledgeChars: 10, rulesKnowledgeHash: 'fixture', arsenalContextChars: 0 });
			return;
		}
		forwardedDecisions++;
		sendJson(response, { batch: {
			schemaVersion: 1, decisionId: input.decisionId,
			observedSequence: input.observation.sequence, observedWorldTick: input.observation.worldTick,
			thoughts: 'Forwarded scripted real-seat fixture.', memo: '', actions: []
		}, usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, costUsd: 0 },
		attempts: [], durationMs: 1 });
	});
	const upstreamPort = await freePort();
	const proxyPort = await freePort();
	await new Promise((resolveListen, reject) => {
		upstream.once('error', reject);
		upstream.listen(upstreamPort, '127.0.0.1', resolveListen);
	});
	const proxy = createBenchmarkAnchorProxy({ upstreamUrl: `http://127.0.0.1:${upstreamPort}`, port: proxyPort });
	await proxy.start();
	try {
		const estimateResponse = await fetch(`${proxy.url}/api/estimate`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
				models: [BenchmarkAnchorModelId, 'scripted/real-seat'], maxOutputTokens: 4096,
				estimatedInputTokens: 8000, estimatedDecisionsPerAgent: 20, strategyArsenalEnabled: false
			})
		});
		const estimate = await estimateResponse.json();
		assert(estimateResponse.status === 200 && estimate.agents.length === 2,
			`mixed anchor estimate failed: ${JSON.stringify(estimate)}`);
		assert(estimate.agents[0].model === BenchmarkAnchorModelId && estimate.agents[0].perDecisionUsd === 0 &&
			estimate.agents[1].model === 'scripted/real-seat' && estimate.agents[1].perDecisionUsd === 0.03,
			`mixed estimate did not preserve zero-cost anchor/real quote: ${JSON.stringify(estimate.agents)}`);

		const observation = { schemaVersion: 1, sequence: 2, worldTick: 100, mapMinX: 0, mapMinY: 0,
			mapMaxX: 80, mapMaxY: 80, actors: [], productionQueues: [] };
		const request = model => ({ schemaVersion: 1, agentId: 'agent-1-fixture', decisionId: 1,
			model, apiKey: 'scripted-no-network-key', systemPrompt: 'fixture', maxOutputTokens: 4096,
			observation, previousResult: '', requestTimeoutMs: 10000, phase: 'live' });
		const anchorOutput = await (await fetch(`${proxy.url}/api/decide`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request(BenchmarkAnchorModelId))
		})).json();
		assert(anchorOutput.anchor.policyDigest === BenchmarkAnchorPolicyDigest && forwardedDecisions === 0,
			'anchor decision was forwarded instead of resolved locally');
		await fetch(`${proxy.url}/api/decide`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request('scripted/real-seat'))
		});
		assert(forwardedDecisions === 1, 'real seat was not forwarded exactly once');
	} finally {
		await proxy.stop();
		await new Promise(resolveClose => upstream.close(resolveClose));
	}
}

try {
	assert(BenchmarkAnchorPolicyDigest === ExpectedAnchorPolicyDigest,
		'anchor policy changed without an independently reviewed gate digest');
	const policyMutations = [
		policy => policy.production.structurePreference.reverse(),
		policy => policy.production.infantryPreference.reverse(),
		policy => policy.production.vehiclePreference.reverse(),
		policy => policy.production.desiredStructureCount.proc++,
		policy => policy.production.structureBatchSize++,
		policy => policy.production.unitBatchSize++,
		policy => policy.production.actionCap--,
		policy => policy.production.queueMode = !policy.production.queueMode,
		policy => policy.combat.deployFirst = !policy.combat.deployFirst,
		policy => policy.combat.idleUnitsOnly = !policy.combat.idleUnitsOnly,
		policy => policy.combat.actorCap--,
		policy => policy.combat.patrol.centerRounding = 'ceil',
		policy => policy.combat.patrol.centerDivisor++,
		policy => policy.combat.patrol.phaseSource = 'observedSequence',
		policy => policy.combat.patrol.phaseOffsets.reverse(),
		policy => policy.combat.patrol.offsetSpan = 'maximum map dimension',
		policy => policy.combat.patrol.minimumOffset++,
		policy => policy.combat.patrol.mapSpanDivisor++,
		policy => policy.maximumActions--
	];
	for (const mutate of policyMutations) {
		const candidate = structuredClone(BenchmarkAnchorPolicyDescriptor);
		mutate(candidate);
		assert(benchmarkAnchorPolicyDigest(candidate) !== BenchmarkAnchorPolicyDigest,
			'anchor behavioural policy mutation did not move policyDigest');
	}
	const fixtureDocument = JSON.parse(readFileSync(fixturePath, 'utf8'));
	assert(fixtureDocument.anchor.policyDigest === ExpectedAnchorPolicyDigest,
		'sweep fixture did not pin the independently reviewed anchor policy digest');
	console.log('OK anchor policy digest covers the behavioural policy arrays');

	const resolved = resolveSweep(fixturePath, { allowTestVector: true });
	assert(resolved.schedule.games.length === 18, '3-model round robin × 3 pairs × 2 legs must schedule 18 games');
	assert(resolved.schedule.anchor.id === BenchmarkAnchorModelId, 'resolved schedule lost the fixed anchor');
	assert(resolved.manifest.dollarStop === false, 'fixture must pin no dollar stop');
	assert(resolved.manifest.decisionIntervalTicks === 250 &&
		resolved.schedule.games.every(game => game.decisionIntervalTicks === 250),
		'sweep schedule did not retain the manifest decision interval');
	for (const matchupId of new Set(resolved.schedule.games.map(game => game.matchupId))) {
		const matchup = resolved.schedule.games.filter(game => game.matchupId === matchupId);
		assert(matchup.length === 6, `${matchupId} must contain three complete pairs`);
		for (const pairId of new Set(matchup.map(game => game.pairId))) {
			const legs = matchup.filter(game => game.pairId === pairId).sort((a, b) => a.leg - b.leg);
			assert(legs.length === 2 && legs[0].seed === legs[1].seed, `${pairId} seed drifted across legs`);
			assert(legs[0].seats[0].modelId === legs[1].seats[1].modelId &&
				legs[0].seats[1].modelId === legs[1].seats[0].modelId,
				`${pairId} did not swap model seats/spawn slots`);
			assert(legs[0].seats[0].faction === legs[1].seats[0].faction &&
				legs[0].seats[1].faction === legs[1].seats[1].faction,
				`${pairId} must pin faction to slot so models swap factions with seats`);
		}
	}
	for (const game of resolved.schedule.games) {
		const args = game.invocation.args;
		for (const required of ['--benchmark-lockstep', '--map', '--benchmark-calibration', '--seed',
			'--tick-horizon', '--decision-horizon', '--decision-timeout-ms'])
			assert(args.includes(required), `${game.gameId} invocation omitted ${required}`);
		for (const forbidden of ['--cap', '--play', '--fallback-strike', '--staff-seat',
			'--executor', '--arsenal', '--guided'])
			assert(!args.includes(forbidden), `${game.gameId} invocation leaked incompatible ${forbidden}`);
	}
	console.log('OK paired schedule covers seed × seat/spawn swap × faction with no dollar stop');

	const generatedEraLockPath = resolve(temporaryDirectory, 'gate.lock.json');
	runNode([eraLockPath, 'generate', '--era', 'benchmark-sweep-gate', '--out', generatedEraLockPath]);
	const eraManifestPath = resolve(temporaryDirectory, 'gate.manifest.json');
	const eraManifest = {
		...JSON.parse(readFileSync(fixturePath, 'utf8')),
		calibration: frozenTestPath,
		eraLock: './gate.lock.json'
	};
	writeFileSync(eraManifestPath, `${JSON.stringify(eraManifest, null, '\t')}\n`);
	const eraResolved = resolveSweep(eraManifestPath, { allowTestVector: true });
	for (const game of eraResolved.schedule.games) {
		const eraArgumentIndex = game.invocation.args.indexOf('--era-lock');
		assert(eraArgumentIndex >= 0 && game.invocation.args[eraArgumentIndex + 1] === generatedEraLockPath,
			`${game.gameId} invocation did not resolve the manifest-relative era lock path`);
	}
	const eraScripted = runScriptedSweep(eraResolved);
	assert(eraScripted.report.eraLock?.era === eraResolved.eraLock.era &&
		eraScripted.report.eraLock?.engineCommit === eraResolved.eraLock.engineCommit &&
		eraScripted.report.eraLock?.lockHash === eraResolved.eraLock.lockHash,
		'series aggregate lost its manifest-supplied era identity');
	console.log('OK manifest era lock reaches every match argv and the aggregate series identity');
	console.log('OK every scheduled invocation carries the manifest era lock');

	const dry = runNode([sweepRunnerPath, '--manifest', fixturePath, '--dry-run', '--test-fixture']);
	const dryDocument = JSON.parse(dry.stdout);
	assert(dryDocument.gameCount === 18 && dryDocument.dollarStop === false &&
		dryDocument.anchor.policyDigest === BenchmarkAnchorPolicyDigest &&
		dryDocument.decisionIntervalTicks === resolved.manifest.decisionIntervalTicks,
		'sweep CLI dry-run drifted from the pure resolved schedule');
	const missingMap = runNode([matchRunnerPath, '--model1', 'scripted/a', '--model2', 'scripted/b',
		'--benchmark-lockstep', '--dry-run'], 2);
	assert(missingMap.stderr.includes('--map is required'), 'match-runner did not reject implicit benchmark map selection');
	const omittedDemoMap = JSON.parse(runNode([matchRunnerPath, '--model1', 'scripted/a',
		'--model2', 'scripted/b', '--dry-run']).stdout);
	assert(omittedDemoMap.requestedMapUid === '' &&
		omittedDemoMap.effectiveMapUid === 'a-nuclear-winter',
		'match-runner omitted-map default is not pinned to the actual Agent Mode demo map');
	const explicitMap = runNode([matchRunnerPath, '--model1', 'scripted/a', '--model2', 'scripted/b',
		'--benchmark-lockstep', '--map', 'Siberian-Pass.oramap', '--dry-run']);
	const explicitMapConfig = JSON.parse(explicitMap.stdout);
	assert(explicitMapConfig.requestedMapUid === 'Siberian-Pass.oramap' &&
		explicitMapConfig.effectiveMapUid === 'Siberian-Pass.oramap',
		'match-runner dry-run did not pin the explicit map');
	for (const assistanceArgs of [
		['--executor'],
		['--arsenal'],
		['--guided']
	]) {
		const contaminatedRun = runNode([
			matchRunnerPath,
			'--model1', 'scripted/a',
			'--model2', 'scripted/b',
			'--benchmark-lockstep',
			'--map', 'Siberian-Pass.oramap',
			'--dry-run',
			...assistanceArgs
		], 2);
		assert(contaminatedRun.stderr.includes('incompatible with --benchmark-lockstep'),
			`${assistanceArgs.join(' ')} did not fail the lockstep raw-track guard`);
	}
	const contaminatedOutcome = scriptedOutcome(resolved.schedule.games[0], resolved.calibration);
	contaminatedOutcome.assistance.executor = true;
	let contaminatedScoreRejected = false;
	try {
		scoreGame(resolved.schedule.games[0], contaminatedOutcome, resolved.calibration);
	} catch (error) {
		contaminatedScoreRejected = /used host assistance/.test(error.message);
	}
	assert(contaminatedScoreRejected, 'scoreGame accepted an outcome with assistance.executor=true');
	console.log('OK lockstep rejects assistance flags and scoreGame refuses contaminated outcomes');
	console.log('OK lockstep refuses assists and scoring refuses an assisted outcome');
	const lessonsRun = runNode([
		matchRunnerPath,
		'--model1', 'scripted/a',
		'--model2', 'scripted/b',
		'--benchmark-lockstep',
		'--map', 'Siberian-Pass.oramap',
		'--lessons', 'on',
		'--dry-run'
	], 2);
	assert(lessonsRun.stderr.includes('--lessons is incompatible with --benchmark-lockstep'),
		'--lessons on was not refused by the lockstep raw-track guard');
	const lessonsOutcome = scriptedOutcome(resolved.schedule.games[0], resolved.calibration);
	lessonsOutcome.assistance.lessons = true;
	let lessonsScoreRejected = false;
	try {
		scoreGame(resolved.schedule.games[0], lessonsOutcome, resolved.calibration);
	} catch (error) {
		lessonsScoreRejected = /used host assistance/.test(error.message);
	}
	assert(lessonsScoreRejected, 'scoreGame accepted an outcome with assistance.lessons=true');
	const falsifiedLessonsOutcome = scriptedOutcome(resolved.schedule.games[0], resolved.calibration);
	falsifiedLessonsOutcome.lessonsMode = 'on';
	let falsifiedLessonsRejected = false;
	try {
		scoreGame(resolved.schedule.games[0], falsifiedLessonsOutcome, resolved.calibration);
	} catch (error) {
		falsifiedLessonsRejected = /lessonsMode must be off/.test(error.message);
	}
	assert(falsifiedLessonsRejected,
		'scoreGame accepted assistance.lessons=false while the recorded lessons mode was on');
	const missingLessonsOutcome = scriptedOutcome(resolved.schedule.games[0], resolved.calibration);
	delete missingLessonsOutcome.assistance.lessons;
	let missingLessonsRejected = false;
	try {
		scoreGame(resolved.schedule.games[0], missingLessonsOutcome, resolved.calibration);
	} catch (error) {
		missingLessonsRejected = /assistance fields must be exactly/.test(error.message);
	}
	assert(missingLessonsRejected, 'scoreGame accepted an outcome whose assistance stamp omitted lessons');
	console.log('OK cross-match lessons cannot enter the skill track undetected');
	const intervalMismatchOutcome = scriptedOutcome(resolved.schedule.games[0], resolved.calibration);
	intervalMismatchOutcome.benchmark.decisionIntervalTicks++;
	let intervalMismatchRejected = false;
	try {
		scoreGame(resolved.schedule.games[0], intervalMismatchOutcome, resolved.calibration);
	} catch (error) {
		intervalMismatchRejected = /host-used decision interval/.test(error.message);
	}
	assert(intervalMismatchRejected, 'scoreGame accepted a host-used decision interval that differed from the manifest');
	const missingIntervalOutcome = scriptedOutcome(resolved.schedule.games[0], resolved.calibration);
	delete missingIntervalOutcome.benchmark.decisionIntervalTicks;
	let missingIntervalRejected = false;
	try {
		scoreGame(resolved.schedule.games[0], missingIntervalOutcome, resolved.calibration);
	} catch (error) {
		missingIntervalRejected = /host-used decision interval/.test(error.message);
	}
	assert(missingIntervalRejected, 'scoreGame defaulted a missing host-used decision interval');
	const matchRunnerSource = readFileSync(matchRunnerPath, 'utf8');
	assert(matchRunnerSource.includes("'Launch.Map': effectiveMapUid") &&
		matchRunnerSource.includes("document.getElementById('agent-map').value = config.effectiveMapUid"),
		'match-runner no longer sends one effective map to shell launch and Agent Mode');
	const hostSource = readFileSync(resolve(repositoryRoot,
		'OpenRA.Browser/AgentMode/AgentModeHost.cs'), 'utf8');
	const contractSource = readFileSync(resolve(repositoryRoot,
		'OpenRA.Browser/AgentMode/AgentModeContracts.cs'), 'utf8');
	const browserIndexSource = readFileSync(browserIndexPath, 'utf8');
	const metricsSource = readFileSync(resolve(repositoryRoot,
		'OpenRA.Browser/tests/a2a-metrics.mjs'), 'utf8');
	assert(hostSource.includes('benchmark lockstep requires an explicit map uid') &&
		hostSource.includes('!string.Equals(map.Uid, requestedMapUid, StringComparison.Ordinal)') &&
		hostSource.includes('!string.Equals(Path.GetFileName(map.Path), requestedMapUid, StringComparison.Ordinal)') &&
		hostSource.includes('benchmark map resolution drifted'),
		'host lost the explicit requested-map vs resolved uid/package assertion');
	assert(contractSource.includes('public string MapUid { get; set; }') &&
		contractSource.includes('public string MapTitle { get; set; }') &&
		hostSource.includes('MapUid = preparedMapUid') && hostSource.includes('MapTitle = preparedMapTitle') &&
		matchRunnerSource.includes('resolvedMapUid: state.mapUid ?? null') &&
		metricsSource.includes('resolvedMapUid: outcome?.map?.resolvedMapUid'),
		'resolved host map identity is not stamped through outcome and metrics');
	const intervalDefault = browserIndexSource.match(
		/id="agent-interval"[^>]*\bvalue="([0-9]+)"/)?.[1];
	assert(Number(intervalDefault) === resolved.manifest.decisionIntervalTicks,
		'browser decision interval default does not match the sweep manifest');
	assert(contractSource.includes('public int? DecisionIntervalTicks { get; set; }') &&
		hostSource.match(/DecisionIntervalTicks = decisionIntervalTicks/g)?.length === 2 &&
		matchRunnerSource.includes('decisionIntervalTicks: matchState.decisionIntervalTicks ?? null') &&
		matchRunnerSource.includes('!Number.isSafeInteger(startedState.decisionIntervalTicks)') &&
		matchRunnerSource.includes('did not report a valid host-used decision interval') &&
		matchRunnerSource.includes('decisionIntervalTicks: effectiveDecisionIntervalTicks'),
		'effective decision interval is not read from the host and stamped into the benchmark outcome');
	console.log('OK the effective decision interval is stamped and cross-checked');
	console.log('OK dry-run pins map/calibration/horizons and rejects implicit map selection');

	let productionGuarded = false;
	try { resolveSweep(fixturePath); } catch (error) {
		productionGuarded = /status=frozen/.test(error.message);
	}
	assert(productionGuarded, 'test-only frozen vector was accepted as production calibration');
	const executeTest = runNode([sweepRunnerPath, '--manifest', fixturePath, '--execute',
		'--confirm-provider-spend', '--test-fixture'], 1);
	assert(executeTest.stderr.includes('can never execute real matches'),
		'test-fixture execution guard did not fire before any match');
	console.log('OK candidate/test calibration cannot leak into a real leaderboard execution');

	const scripted = runScriptedSweep(resolved);
	assert(scripted.records.some(record => record.terminalOverride) &&
		scripted.records.some(record => !record.terminalOverride),
		'scripted series must exercise terminal and composite adjudication');
	assert(scripted.report.gameCount === 18 && scripted.report.matchups.every(matchup =>
		matchup.pairs === 3 && matchup.score.clusterCount === 3 &&
		matchup.score.method.includes('seed-pair')),
		'mean-score intervals are not clustered by independent seed pair');
	const anchor = scripted.report.models.find(model => model.anchor);
	assert(anchor.skillElo.rating === 1200 && anchor.skillElo.lower === 1200 && anchor.skillElo.upper === 1200 &&
		anchor.skillElo.method === 'fixed-scale-origin', 'anchor Elo was not pinned to the arbitrary 1200 origin');
	const modelIds = resolved.schedule.models.map(model => model.id);
	const forwardElo = anchoredElo(scripted.records, modelIds, BenchmarkAnchorModelId);
	const reversedElo = anchoredElo([...scripted.records].reverse(), modelIds, BenchmarkAnchorModelId);
	assert(modelIds.every(modelId => Math.abs(forwardElo[modelId] - reversedElo[modelId]) < 1e-9),
		'anchored batch Elo depends on match arrival order');
	for (const model of scripted.report.models) {
		assert(canonicalJson(Object.keys(model.components).sort()) === canonicalJson([...ComponentFields].sort()),
			`${model.modelId} does not report all six raw component columns`);
		assert(model.operations.latencyMs != null && Number.isFinite(model.operations.spendUsd) &&
			Number.isFinite(model.operations.fallbackRate),
			`${model.modelId} operational columns are incomplete`);
	}
	console.log('OK terminal/composite scores aggregate to W/D/L + pair-clustered CI + anchored Elo');
	console.log('OK six components stay separate from latency/spend/fallback/no-op operational columns');

	const planning = scriptedAnchorDecision({ model: BenchmarkAnchorModelId, phase: 'planning', decisionId: 0,
		observation: { sequence: 1, worldTick: 0 } });
	assert(planning.batch.actions.length === 0 && planning.anchor.policyDigest === BenchmarkAnchorPolicyDigest,
		'anchor planning policy is not deterministic/version-pinned');
	PlanningBatchSchema.parse(planning.batch);
	const liveInput = { model: BenchmarkAnchorModelId, phase: 'live', decisionId: 5, observation: {
		sequence: 6, worldTick: 1000, mapMinX: 0, mapMinY: 0, mapMaxX: 80, mapMaxY: 80,
		actors: [{ actorId: 10, type: 'mcv', relationship: 'self', idle: true, capabilities: ['deploy'] }],
		productionQueues: []
	} };
	const liveA = scriptedAnchorDecision(liveInput);
	const liveB = scriptedAnchorDecision(structuredClone(liveInput));
	assert(canonicalJson(liveA) === canonicalJson(liveB) && liveA.batch.actions[0].type === 'deploy',
		'anchor policy is not deterministic/meaningful on a deploy opportunity');
	AgentActionBatchSchema.parse(liveA.batch);
	const fieldPolicy = scriptedAnchorDecision({ model: BenchmarkAnchorModelId, phase: 'live', decisionId: 6,
		observation: { sequence: 7, worldTick: 1200, mapMinX: 0, mapMinY: 0, mapMaxX: 80, mapMaxY: 80,
			actors: [
				{ actorId: 20, type: 'fact', relationship: 'self', idle: true, capabilities: ['startProduction'] },
				{ actorId: 21, type: '3tnk', relationship: 'self', idle: true,
					capabilities: ['attackMove', 'attack'] },
				{ actorId: 30, type: 'e1', relationship: 'enemy', idle: false, capabilities: [] }
			],
			productionQueues: [{ producerId: 20, queueType: 'Building', buildableItems: ['powr'], items: [] }]
		} });
	AgentActionBatchSchema.parse(fieldPolicy.batch);
	assert(fieldPolicy.batch.actions.some(action => action.type === 'startProduction') &&
		fieldPolicy.batch.actions.some(action => action.type === 'attack'),
		'normal anchor did not exercise its deterministic economy+combat policy');
	await proxyGate();
	console.log(`OK normal-seat anchor policy v${BenchmarkAnchorSpec.policyVersion} ` +
		`${BenchmarkAnchorPolicyDigest} is deterministic and loopback-routed`);
	console.log('BENCHMARK SWEEP GATE RESULT: PASS');
} catch (error) {
	console.error(`BENCHMARK SWEEP GATE FAILED: ${error.message}`);
	process.exitCode = 1;
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
