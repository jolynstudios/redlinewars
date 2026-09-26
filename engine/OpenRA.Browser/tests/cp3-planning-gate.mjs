// Era 3 CP3 Release lifecycle gate: pre-match planning is symmetric, strict,
// stale-safe, atomic at warmup, and backward compatible with StartAgentMatch.
//
// This gate uses only public JS exports and synchronized host actions. It does
// not mutate the world or depend on model/network variance.
//
// Usage (from the repository root):
//   node OpenRA.Browser/tests/cp3-planning-gate.mjs [--headed] [--repo /path/to/OpenRA]
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const args = process.argv.slice(2);
let headed = false;
let repoRoot = path.resolve(process.cwd());
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--headed') {
		headed = true;
	} else if (args[i] === '--repo' && args[i + 1] != null) {
		repoRoot = path.resolve(args[++i]);
	} else {
		console.error(`Unknown argument: ${args[i]}`);
		console.error('Usage: node OpenRA.Browser/tests/cp3-planning-gate.mjs [--headed] [--repo /path/to/OpenRA]');
		process.exit(2);
	}
}

const testsDir = path.join(repoRoot, 'OpenRA.Browser', 'tests');
const bundleIndex = path.join(repoRoot, 'bin-browser', 'AppBundle', 'index.html');
await access(path.join(testsDir, 'server.mjs'));
await access(bundleIndex);

// Resolve Playwright as though this gate lived beside the repository gates.
const require = createRequire(path.join(testsDir, 'cp3-planning-gate.mjs'));
const { chromium } = require('@playwright/test');

const port = 8364;
const serverUrl = `http://127.0.0.1:${port}/`;
const url = `${serverUrl}index.html?mode=game&platform=webgl2&Host.DevContent=1&Host.AgentMode=1&` +
	'Launch.Map=Siberian-Pass.oramap&Debug.ServerRandomSeed=67891';
const MaxJsonBytes = 256 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let browser;
let page;
let cleanupPromise;

function assert(condition, message) {
	if (!condition)
		throw new Error(message);
}

function assertJsonEqual(actual, expected, message) {
	assert(JSON.stringify(actual) === JSON.stringify(expected),
		`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

async function probe(target, timeoutMs = 500) {
	try {
		const response = await fetch(target, {
			signal: AbortSignal.timeout(timeoutMs),
			cache: 'no-store'
		});
		await response.body?.cancel();
		return response.status;
	} catch {
		return null;
	}
}

async function stopChild(child) {
	if (child == null || child.exitCode != null || child.signalCode != null)
		return;

	const exited = new Promise(resolve => child.once('exit', resolve));
	child.kill('SIGTERM');
	await Promise.race([exited, delay(2000)]);
	if (child.exitCode == null && child.signalCode == null) {
		child.kill('SIGKILL');
		await Promise.race([exited, delay(2000)]);
	}
}

function cleanup() {
	if (cleanupPromise == null) {
		cleanupPromise = Promise.allSettled([
			browser == null ? Promise.resolve() : Promise.resolve().then(() => browser.close()),
			stopChild(server)
		]);
	}

	return cleanupPromise;
}

const onSignal = signal => {
	const exitCode = signal === 'SIGINT' ? 130 : 143;
	void cleanup().finally(() => process.exit(exitCode));
};
const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

async function waitForOwnedServer(child, startup) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (startup.error != null)
			throw new Error(`Could not start the bundle server: ${startup.error.message}`);
		if (child.exitCode != null || child.signalCode != null)
			throw new Error(`Bundle server exited before readiness: ${startup.stderr.trim().slice(-500)}`);
		if (startup.listening && await probe(serverUrl) === 200)
			return;
		await delay(100);
	}

	throw new Error(`Bundle server did not become ready at ${serverUrl} within 10 seconds.`);
}

async function exported(method, ...args) {
	return page.evaluate(({ method, args }) => {
		const fn = globalThis.ora?.[method];
		if (typeof fn !== 'function')
			throw new Error(`missing public export ${method}`);
		return fn(...args);
	}, { method, args });
}

async function rawJson(method, ...args) {
	const text = await exported(method, ...args);
	assert(typeof text === 'string', `${method} returned non-string ${typeof text}`);
	return { text, value: JSON.parse(text) };
}

async function call(method, ...args) {
	const result = await rawJson(method, ...args);
	if (result.value?.error)
		throw new Error(`${method}: ${result.value.error}`);
	return result.value;
}

async function expectError(method, args, includes) {
	const result = await rawJson(method, ...args);
	assert(typeof result.value?.error === 'string',
		`${method} unexpectedly succeeded: ${result.text}`);
	if (includes != null)
		assert(result.value.error.includes(includes),
			`${method} error '${result.value.error}' does not include '${includes}'`);
	return result.value.error;
}

async function readState({ allowFailed = false } = {}) {
	const current = await call('GetAgentMatchState');
	assert(!current.outOfSync,
		`DESYNC at tick ${current.worldTick}, net ${current.netFrame}: ${JSON.stringify(current)}`);
	if (!allowFailed && current.state === 'failed')
		throw new Error(`Agent match failed: ${current.terminalReason ?? current.fakeAgentStatus}`);
	return current;
}

async function waitFor(label, predicate, timeoutMs = 120_000, intervalMs = 50) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	while (Date.now() < deadline) {
		latest = await predicate();
		if (latest) {
			console.log(`OK ${label}`);
			return latest;
		}
		await delay(intervalMs);
	}

	throw new Error(`TIMEOUT ${label}; latest=${JSON.stringify(latest)}`);
}

async function planningManifestPreflight() {
	const envelope = await call('GetAgentContractManifest');
	const schema = await call('GetAgentActionSchema');
	assert(/^[0-9a-f]{64}$/.test(envelope.fingerprint ?? ''),
		`planning host manifest fingerprint is invalid: ${envelope.fingerprint}`);
	assert(schema.era === 'era3-skills' && schema.schemaVersion === 1,
		`action schema identity drifted: ${JSON.stringify(schema).slice(0, 500)}`);
	assert(schema.contractFingerprint === envelope.fingerprint,
		`action schema/manifest fingerprint mismatch: ${schema.contractFingerprint} != ${envelope.fingerprint}`);
	assertJsonEqual(schema.contractManifest, envelope.manifest,
		'action schema embeds a different contract manifest');
	assertJsonEqual(envelope.manifest.planning, {
		maxActionsPerPlanning: 2,
		batchInvariants: [
			'at most one queueBuildPlan',
			'at most one setPolicy',
			'identity literals decisionId=0 observedSequence=1 observedWorldTick=0'
		],
		variants: [
			{
				variantId: 'queueBuildPlan',
				type: 'queueBuildPlan',
				fields: ['planId', 'reserveCash', 'steps', 'type', 'version'],
				stringEnums: [{ field: 'type', values: ['queueBuildPlan'] }]
			},
			{
				variantId: 'setPolicy',
				type: 'setPolicy',
				fields: [
					'autoRepairBuildings', 'autoReturnFire', 'defendCriticalAssets', 'harvesterFlee',
					'rallyNewUnitsToDefense', 'retreatBelowHpPercent', 'type'
				],
				stringEnums: [{ field: 'type', values: ['setPolicy'] }]
			}
		]
	}, 'host planning manifest drifted');
	assert(envelope.manifest.configSurface.includes('prematchPlanning:boolean default=false') &&
		envelope.manifest.configSurface.includes('planningTimeoutMs:integer clamp=10000..120000 default=30000'),
		`planning config surface is incomplete: ${JSON.stringify(envelope.manifest.configSurface)}`);
	console.log(`OK planning manifest/export fingerprint ${envelope.fingerprint}`);
}

function policy(overrides = {}) {
	return {
		type: 'setPolicy',
		autoReturnFire: false,
		harvesterFlee: false,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: false,
		autoRepairBuildings: false,
		retreatBelowHpPercent: 0,
		...overrides
	};
}

function policyValues(overrides = {}) {
	const { type: _type, ...values } = policy(overrides);
	return values;
}

function defaultPolicyValues() {
	return {
		autoReturnFire: true,
		harvesterFlee: true,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: true,
		autoRepairBuildings: false,
		retreatBelowHpPercent: 0
	};
}

function policyMatches(actual, expected) {
	return actual != null && Object.entries(expected).every(([field, value]) => actual[field] === value);
}

function assertPolicy(actual, expected, label) {
	assert(policyMatches(actual, expected),
		`${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function planningBatch(actions, overrides = {}) {
	return {
		schemaVersion: 1,
		decisionId: 0,
		observedSequence: 1,
		observedWorldTick: 0,
		thoughts: 'CP3 deterministic pre-match planning fixture.',
		memo: '',
		actions,
		...overrides
	};
}

function lockstepPlanningBatch(seat, actions = []) {
	return {
		schemaVersion: 1,
		decisionId: seat.decisionId,
		observedSequence: seat.observationSequence,
		observedWorldTick: seat.observation.worldTick,
		thoughts: 'CP3 benchmark barrier-zero fixture.',
		memo: '',
		actions
	};
}

function gameplayBatch(observation, decisionId, actions = []) {
	return {
		schemaVersion: 1,
		decisionId,
		observedSequence: observation.sequence,
		observedWorldTick: observation.worldTick,
		thoughts: `CP3 deterministic gameplay decision ${decisionId}.`,
		memo: '',
		actions
	};
}

function planningConfig(overrides = {}) {
	return {
		schemaVersion: 1,
		fakeAgents: false,
		decisionIntervalTicks: 500,
		prematchPlanning: true,
		planningTimeoutMs: 10_000,
		faction1: 'russia',
		faction2: 'england',
		...overrides
	};
}

async function prepare(overrides = {}) {
	const requestedMap = overrides.benchmarkLockstepEnabled ? 'Siberian-Pass.oramap' : '';
	const prepared = await call('PrepareAgentMatch', requestedMap, JSON.stringify(planningConfig(overrides)));
	assert(prepared.prematchPlanning === true && prepared.planningTimeoutMs === 10_000,
		`unexpected planning start result: ${JSON.stringify(prepared)}`);
	assert(Array.isArray(prepared.agentIds) && prepared.agentIds.length === 2,
		`planning fixture requires two agent seats: ${JSON.stringify(prepared)}`);
	const current = await readState();
	assert(current.state === 'planning' && current.matchId === prepared.matchId &&
		current.worldTick === 0 && current.netFrame === 0,
		`prepared state is invalid: ${JSON.stringify(current)}`);
	return prepared;
}

async function planningObservation(agentId) {
	const result = await rawJson('GetAgentObservation', agentId, 0);
	if (result.value?.error)
		throw new Error(`GetAgentObservation: ${result.value.error}`);
	assert(Buffer.byteLength(result.text, 'utf8') <= MaxJsonBytes,
		`planning observation exceeds ${MaxJsonBytes} bytes`);
	return result.value;
}

function assertSymmetricPlanningObservations(first, second, prepared, expectedFactions) {
	const observationKeys = [
		'agentId', 'map', 'matchId', 'opponent', 'phase', 'player',
		'schemaVersion', 'sequence', 'worldTick'
	].sort();
	const observations = [first, second];
	for (let i = 0; i < observations.length; i++) {
		const observation = observations[i];
		assertJsonEqual(Object.keys(observation).sort(), observationKeys,
			'planning observation fields drifted');
		assert(observation.phase === 'planning' && observation.sequence === 1 && observation.worldTick === 0,
			`planning identity is invalid: ${JSON.stringify(observation)}`);
		assert(observation.matchId === prepared.matchId && observation.agentId === prepared.agentIds[i],
			`planning observation identity is mapped to the wrong seat: ${JSON.stringify(observation)}`);
		assertJsonEqual(Object.keys(observation.player).sort(), ['faction'],
			'planning player leaked non-public fields');
		assertJsonEqual(Object.keys(observation.opponent).sort(), ['faction'],
			'planning opponent leaked non-public fields');
		assert(observation.player.faction === expectedFactions[i] &&
			observation.opponent.faction === expectedFactions[1 - i],
			`planning factions are mapped to the wrong seats: ${JSON.stringify(observation)}`);
		assert(observation.player.spawnPoint === undefined && observation.player.spawnCell === undefined,
			'planning player leaked an assigned spawn');
		assert(observation.opponent.spawnPoint === undefined && observation.opponent.spawnCell === undefined,
			'planning opponent leaked an assigned spawn');
		assertJsonEqual(Object.keys(observation.map).sort(),
			['candidateSpawnPoints', 'maxX', 'maxY', 'minX', 'minY', 'title', 'uid'],
			'planning map fields drifted');
		assert(observation.map.uid === prepared.mapUid && observation.map.title === prepared.mapTitle,
			`planning map identity drifted: ${JSON.stringify(observation.map)}`);
		assert(Number.isInteger(observation.map.minX) && Number.isInteger(observation.map.minY) &&
			Number.isInteger(observation.map.maxX) && Number.isInteger(observation.map.maxY) &&
			observation.map.minX <= observation.map.maxX && observation.map.minY <= observation.map.maxY,
			`planning map bounds are invalid: ${JSON.stringify(observation.map)}`);
		assert(Array.isArray(observation.map.candidateSpawnPoints) &&
			observation.map.candidateSpawnPoints.length >= 2,
			`candidate spawn list is invalid: ${JSON.stringify(observation.map)}`);
		const candidateCells = new Set();
		for (let j = 0; j < observation.map.candidateSpawnPoints.length; j++) {
			const candidate = observation.map.candidateSpawnPoints[j];
			assertJsonEqual(Object.keys(candidate).sort(), ['cell', 'spawnPoint'],
				'candidate spawn fields drifted');
			assertJsonEqual(Object.keys(candidate.cell ?? {}).sort(), ['x', 'y'],
				'candidate spawn cell fields drifted');
			assert(candidate.spawnPoint === j + 1 && Number.isInteger(candidate.cell?.x) &&
				Number.isInteger(candidate.cell?.y) && candidate.cell.x >= observation.map.minX &&
				candidate.cell.x <= observation.map.maxX && candidate.cell.y >= observation.map.minY &&
				candidate.cell.y <= observation.map.maxY,
				`candidate spawn is invalid: ${JSON.stringify(candidate)}`);
			candidateCells.add(`${candidate.cell.x},${candidate.cell.y}`);
		}
		assert(candidateCells.size === observation.map.candidateSpawnPoints.length,
			`candidate spawn cells are not unique: ${JSON.stringify(observation.map.candidateSpawnPoints)}`);
	}

	assert(first.matchId === second.matchId, 'planning observations refer to different matches');
	assertJsonEqual(first.map, second.map, 'candidate map/spawn knowledge is not symmetric');
	assert(first.player.faction === second.opponent.faction &&
		second.player.faction === first.opponent.faction,
		`public factions are not symmetric: ${JSON.stringify({ first, second })}`);
}

async function regularObservation(agentId) {
	const result = await rawJson('GetAgentObservation', agentId, 0);
	if (result.value?.error)
		throw new Error(`GetAgentObservation: ${result.value.error}`);
	assert(Buffer.byteLength(result.text, 'utf8') <= MaxJsonBytes,
		`regular observation exceeds ${MaxJsonBytes} bytes`);
	return result.value;
}

async function waitForMappedWarmup(label, prepared, evidence = () => true) {
	return waitFor(label, async () => {
		const current = await readState();
		if (current.state !== 'running' || current.matchId !== prepared.matchId || current.worldTick < 25 ||
			current.agents.length !== prepared.agentIds.length ||
			prepared.agentIds.some(agentId =>
				!current.agents.some(agent => agent.agentId === agentId && agent.clientIndex >= 0)))
			return false;

		let observations;
		try {
			observations = await Promise.all(prepared.agentIds.map(regularObservation));
		} catch {
			return false;
		}
		return evidence(observations, current) ? { state: current, observations } : false;
	});
}

function assertLiveContinuity(prepared, planningObservations, liveObservations) {
	const spawnPoints = [];
	for (let i = 0; i < liveObservations.length; i++) {
		const live = liveObservations[i];
		const planning = planningObservations[i];
		assert(live.matchId === prepared.matchId && live.agentId === prepared.agentIds[i],
			`live observation identity changed seats: ${JSON.stringify(live)}`);
		assert(live.player.faction === planning.player.faction,
			`live faction drifted from planning: ${JSON.stringify({ planning: planning.player, live: live.player })}`);
		assert(Number.isInteger(live.player.spawnPoint) &&
			planning.map.candidateSpawnPoints.some(candidate => candidate.spawnPoint === live.player.spawnPoint),
			`live spawn was not selected from the public candidates: ${JSON.stringify(live.player)}`);
		spawnPoints.push(live.player.spawnPoint);
	}
	assert(new Set(spawnPoints).size === spawnPoints.length,
		`live seats share an assigned spawn: ${JSON.stringify(spawnPoints)}`);
}

function stateAgent(current, agentId) {
	return current.agents.find(agent => agent.agentId === agentId);
}

async function stopMatch(label) {
	const stopped = await exported('StopAgentMatch');
	assert(stopped === 'stopped', `${label} stop failed: ${stopped}`);
	const inactive = await readState();
	assert(inactive.state === 'inactive', `${label} did not reset host state: ${JSON.stringify(inactive)}`);
}

try {
	if (await probe(serverUrl) != null)
		throw new Error(`Port ${port} is already serving HTTP; refusing to adopt an unowned server.`);

	const startup = { listening: false, stderr: '', error: null };
	server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(port)], {
		cwd: repoRoot,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.once('error', error => { startup.error = error; });
	server.stdout.on('data', chunk => {
		if (String(chunk).includes('[server] serving '))
			startup.listening = true;
	});
	server.stderr.on('data', chunk => {
		startup.stderr = `${startup.stderr}${String(chunk)}`.slice(-2000);
	});
	await waitForOwnedServer(server, startup);

	browser = await chromium.launch({ headless: !headed });
	page = await browser.newPage();
	page.on('pageerror', error => console.error('[pageerror]', String(error)));
	page.on('console', message => {
		if (/\[host\]|FATAL|agent|planning|PASS|FAIL/i.test(message.text()))
			console.log(`[console] ${message.text().slice(0, 300)}`);
	});
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240_000 });
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => {
		try { return globalThis.ora.IsRunning(); } catch { return false; }
	}, undefined, { timeout: 60_000 });
	await page.waitForFunction(() => globalThis.ora.GetNetFrame() >= 25, undefined, { timeout: 60_000 });
	console.log('OK Release browser booted with advancing direct-launch world');
	await planningManifestPreflight();

	// Benchmark planning is barrier zero, not the legacy Stage* flow. Both
	// cached observations share the synthetic 0/1/0 clock; a timed-out seat is
	// committed as a deterministic no-op and live decision identities start at
	// one only after this single combined close.
	const barrierZero = await prepare({
		benchmarkLockstepEnabled: true,
		benchmarkSpecVersion: 'benchmark-lockstep-v1',
		benchmarkDecisionTimeoutMs: 10_000,
		benchmarkTickHorizon: 5000,
		benchmarkDecisionHorizon: 3,
		advisorFallbackEnabled: false,
		playCadenceEnabled: false
	});
	assert(barrierZero.resolvedProfile === 'benchmark-lockstep' &&
		barrierZero.benchmarkLockstep?.specVersion === 'benchmark-lockstep-v1',
		`benchmark preparation did not expose its pinned spec: ${JSON.stringify(barrierZero)}`);
	const zero = await call('GetAgentLockstepBarrier');
	assert(zero.barrierId === 0 && zero.prematch === true && zero.phase === 'Collecting' &&
		zero.seats.length === 2 && zero.seats.every(seat => seat.decisionId === 0 &&
			seat.observationSequence === 1 && seat.observation?.phase === 'planning' &&
			seat.observation?.worldTick === 0),
		`benchmark barrier zero identity/snapshots drifted: ${JSON.stringify(zero)}`);
	await expectError('GetAgentObservation', [barrierZero.agentIds[0], 0],
		'legacy observation/due/submit APIs are disabled');
	const zeroCommit = await call('CommitAgentLockstepBarrier', JSON.stringify({
		schemaVersion: 1,
		specVersion: 'benchmark-lockstep-v1',
		barrierId: 0,
		seats: [
			{
				agentId: zero.seats[0].agentId,
				decisionId: 0,
				status: 'valid',
				batch: lockstepPlanningBatch(zero.seats[0]),
				durationMs: 10
			},
			{
				agentId: zero.seats[1].agentId,
				decisionId: 0,
				status: 'timeout',
				reason: 'CP3 scripted planning deadline.',
				durationMs: 10_000
			}
		]
	}));
	assert(zeroCommit.barrierId === 0 && zeroCommit.seats[0].outcome === 'Valid' &&
		zeroCommit.seats[1].outcome === 'NoOpTimeout',
		`barrier-zero outcome policy drifted: ${JSON.stringify(zeroCommit)}`);
	const closedZero = await call('GetAgentLockstepBarrier');
	assert(closedZero.barrierId === 0 && closedZero.phase === 'Idle' && closedZero.prematch === true &&
		closedZero.decisionOpportunitiesPerSeat === 0,
		`barrier zero did not close once without consuming live ids: ${JSON.stringify(closedZero)}`);
	await expectError('CommitAgentLockstepBarrier', [JSON.stringify({
		schemaVersion: 1, specVersion: 'benchmark-lockstep-v1', barrierId: 0, seats: []
	})], 'no benchmark lockstep barrier is active');
	assert(JSON.parse(await exported('LaunchPreparedAgentMatch', barrierZero.matchId)).launched === true,
		'barrier-zero match did not launch');
	await waitFor('barrier-zero launch reaches the regular world without OOS', async () => {
		const current = await readState();
		return current.state === 'running' && current.worldTick >= 0 ? current : false;
	}, 60_000, 50);
	await stopMatch('barrier-zero');
	console.log('OK benchmark barrier zero pairs 0/1/0 snapshots and reserves live decision 1');

	// Prepared Stop must reset only Agent mode. It must not disconnect or replace
	// the direct-launch world that existed before preparation.
	const beforePrepareNetFrame = await exported('GetNetFrame');
	const preparedStop = await prepare();
	const directNetFrame = await exported('GetNetFrame');
	assert(await exported('IsRunning'), 'Prepare stopped the existing browser world');
	assert(directNetFrame >= beforePrepareNetFrame,
		`Prepare replaced/disconnected the existing world (${beforePrepareNetFrame} -> ${directNetFrame})`);
	await stopMatch('prepared');
	const afterPreparedStopNetFrame = await exported('GetNetFrame');
	assert(await exported('IsRunning'), 'prepared Stop stopped the browser engine');
	assert(afterPreparedStopNetFrame >= directNetFrame,
		`prepared Stop replaced/disconnected the existing world (${directNetFrame} -> ${afterPreparedStopNetFrame})`);
	console.log('OK prepared Stop leaves the existing world intact');

	// A new preparation makes the previous match id and agent ids stale. Reject
	// them without disturbing the current prepared match.
	const failing = await prepare();
	await expectError('PrepareAgentMatch', ['', JSON.stringify(planningConfig())],
		'an Agent mode match is already active');
	await expectError('LaunchPreparedAgentMatch', [preparedStop.matchId], 'stale prepared match id');
	await expectError('StageAgentPlanningActions', [preparedStop.agentIds[0],
		JSON.stringify(planningBatch([]))], 'unknown agent id');
	const stillPrepared = await readState();
	assert(stillPrepared.state === 'planning' && stillPrepared.matchId === failing.matchId,
		`stale calls disturbed the current preparation: ${JSON.stringify(stillPrepared)}`);

	const failingObservations = await Promise.all(failing.agentIds.map(planningObservation));
	assertSymmetricPlanningObservations(failingObservations[0], failingObservations[1], failing,
		['russia', 'england']);
	console.log('OK planning DTO is bounded, public-only, and spawn-symmetric');

	// Every synthetic identity literal is pinned, and the planning vocabulary is
	// a strict queueBuildPlan/setPolicy union with no extra fields or duplicates.
	for (const [field, value] of [
		['schemaVersion', 2],
		['decisionId', 1],
		['observedSequence', 2],
		['observedWorldTick', 1]
	]) {
		await expectError('StageAgentPlanningActions', [failing.agentIds[0],
			JSON.stringify(planningBatch([], { [field]: value }))], 'planning identity');
	}
	const duplicateFieldBatch = JSON.stringify(planningBatch([]))
		.replace('"decisionId":0', '"decisionId":0,"decisionId":0');
	await expectError('StageAgentPlanningActions', [failing.agentIds[0], duplicateFieldBatch],
		"duplicate field 'decisionId'");
	await expectError('StageAgentPlanningActions', [failing.agentIds[0],
		JSON.stringify(planningBatch([{ type: 'surrender' }]))], 'does not support action type');
	await expectError('StageAgentPlanningActions', [failing.agentIds[0],
		JSON.stringify(planningBatch([{ ...policy(), unexpected: true }]))], 'unknown field');
	await expectError('StageAgentPlanningActions', [failing.agentIds[0],
		JSON.stringify(planningBatch([policy(), policy()]))], 'at most one setPolicy');
	console.log('OK Stage rejects identity drift, unknown vocabulary, extra fields, and duplicate variants');

	// Cross-seat prevalidation is atomic: the second seat's syntactically valid
	// but world-invalid item must fail before the first seat's policy mutates.
	let staged = await call('StageAgentPlanningActions', failing.agentIds[0], JSON.stringify(planningBatch([
		policy({ autoRepairBuildings: true })
	])));
	assert(staged.accepted === 1 && staged.rejected === 0,
		`valid policy did not stage: ${JSON.stringify(staged)}`);
	staged = await call('StageAgentPlanningActions', failing.agentIds[1], JSON.stringify(planningBatch([
		{
			type: 'queueBuildPlan',
			planId: 'world-invalid',
			version: 1,
			reserveCash: 0,
			steps: [{ item: 'cp3-not-a-real-buildable', count: 1 }]
		}
	])));
	assert(staged.accepted === 1 && staged.rejected === 0,
		`world-invalid plan should be staged for live-world validation: ${JSON.stringify(staged)}`);
	assert(JSON.parse(await exported('LaunchPreparedAgentMatch', failing.matchId)).launched === true,
		'prepared atomic-failure match did not launch');
	await expectError('LaunchPreparedAgentMatch', [failing.matchId], 'already launched');
	const failedState = await waitFor('world-invalid planning fails at warmup without OOS', async () => {
		const current = await readState({ allowFailed: true });
		return current.state === 'failed' ? current : false;
	});
	assert(failedState.worldTick >= 25 && /unknown build-plan item/.test(failedState.terminalReason),
		`unexpected planning failure: ${JSON.stringify(failedState)}`);
	const unappliedPolicy = await regularObservation(failing.agentIds[0]);
	const unappliedPlan = await regularObservation(failing.agentIds[1]);
	assertLiveContinuity(failing, failingObservations, [unappliedPolicy, unappliedPlan]);
	assertPolicy(unappliedPolicy.hostTruth.standingPolicy, defaultPolicyValues(),
		'first seat policy mutated before cross-seat validation completed');
	assertPolicy(unappliedPlan.hostTruth.standingPolicy, defaultPolicyValues(),
		'second seat policy changed during atomic failure');
	assert(unappliedPolicy.hostTruth.buildPlan == null && unappliedPlan.hostTruth.buildPlan == null,
		`a build plan partially applied during atomic failure: ${JSON.stringify([
			unappliedPolicy.hostTruth.buildPlan, unappliedPlan.hostTruth.buildPlan
		])}`);
	assert(failedState.agents.every(agent => agent.decisionOpportunities === 0),
		`failed planning counted a decision opportunity: ${JSON.stringify(failedState.agents)}`);
	console.log('OK staged batches fail atomically before either host controller mutates');
	await stopMatch('atomic-failure');

	// Fail open when the runner's planning deadline expires with one planner still
	// missing: launch the staged seat and treat the unstaged seat as an empty
	// planning batch. Both seats must still consume reserved decision 0.
	const failOpen = await prepare();
	const failOpenPlanning = await Promise.all(failOpen.agentIds.map(planningObservation));
	assertSymmetricPlanningObservations(failOpenPlanning[0], failOpenPlanning[1], failOpen,
		['russia', 'england']);
	const failOpenPolicy = policy({
		autoRepairBuildings: true,
		retreatBelowHpPercent: 25
	});
	const failOpenExpectedPolicy = policyValues({
		autoRepairBuildings: true,
		retreatBelowHpPercent: 25
	});
	const defaultPolicy = defaultPolicyValues();
	staged = await call('StageAgentPlanningActions', failOpen.agentIds[0],
		JSON.stringify(planningBatch([failOpenPolicy])));
	assert(staged.accepted === 1 && staged.rejected === 0 && staged.results[0]?.accepted,
		`single-seat planning batch did not stage: ${JSON.stringify(staged)}`);
	await expectError('StageAgentPlanningActions', [failOpen.agentIds[0],
		JSON.stringify(planningBatch([policy({ autoReturnFire: true })]))],
		'planning decision 0 has already been staged');
	// Deliberately do not stage failOpen.agentIds[1], modeling a timed-out planner
	// when the runner invokes the public launch export at its planning deadline.
	assert(JSON.parse(await exported('LaunchPreparedAgentMatch', failOpen.matchId)).launched === true,
		'partial planning match did not fail open at launch');
	const failOpenWarmup = await waitForMappedWarmup(
		'partial planning launches, maps both seats, and applies staged evidence without OOS',
		failOpen, observations =>
			policyMatches(observations[0].hostTruth.standingPolicy, failOpenExpectedPolicy) &&
			policyMatches(observations[1].hostTruth.standingPolicy, defaultPolicy));
	const failOpenLive = failOpenWarmup.observations;
	assertLiveContinuity(failOpen, failOpenPlanning, failOpenLive);
	assertPolicy(failOpenLive[0].hostTruth.standingPolicy, failOpenExpectedPolicy,
		'staged fail-open policy was not applied');
	assertPolicy(failOpenLive[1].hostTruth.standingPolicy, defaultPolicy,
		'unstaged fail-open seat changed its default policy');
	assert(failOpenLive.every(observation => observation.hostTruth.buildPlan == null),
		`policy-only fail-open created a build plan: ${JSON.stringify(failOpenLive.map(o => o.hostTruth.buildPlan))}`);
	assert(stateAgent(failOpenWarmup.state, failOpen.agentIds[0])?.decisionOpportunities === 1 &&
		stateAgent(failOpenWarmup.state, failOpen.agentIds[1])?.decisionOpportunities === 0,
		`planning timeout opportunity accounting is invalid: ${JSON.stringify(failOpenWarmup.state.agents)}`);

	for (let i = 0; i < failOpen.agentIds.length; i++) {
		await expectError('SubmitAgentActions', [failOpen.agentIds[i],
			JSON.stringify(gameplayBatch(failOpenLive[i], 0))], 'duplicate or out-of-order decisionId 0');
	}
	for (let i = 0; i < failOpen.agentIds.length; i++) {
		const accepted = await call('SubmitAgentActions', failOpen.agentIds[i],
			JSON.stringify(gameplayBatch(failOpenLive[i], 1)));
		assert(accepted.decisionId === 1 && accepted.accepted === 0 && accepted.rejected === 0,
			`fail-open seat ${i} rejected normal decision 1: ${JSON.stringify(accepted)}`);
	}
	const failOpenAfterDecisions = await readState();
	assert(stateAgent(failOpenAfterDecisions, failOpen.agentIds[0])?.decisionOpportunities === 2 &&
		stateAgent(failOpenAfterDecisions, failOpen.agentIds[1])?.decisionOpportunities === 1,
		`live decision opportunity accounting is invalid: ${JSON.stringify(failOpenAfterDecisions.agents)}`);
	console.log('OK missing planning seat fails open with defaults and both seats advance to decision 1');
	await stopMatch('partial-planning');

	// Happy path: both seats stage valid actions, launch, and expose the complete
	// plan/policy state at the first safe warmup boundary.
	const successful = await prepare();
	const successfulPlanning = await Promise.all(successful.agentIds.map(planningObservation));
	assertSymmetricPlanningObservations(successfulPlanning[0], successfulPlanning[1], successful,
		['russia', 'england']);
	const firstPolicy = policy({
		rallyNewUnitsToDefense: true,
		autoRepairBuildings: true,
		retreatBelowHpPercent: 35
	});
	const secondPolicy = policy({ defendCriticalAssets: true, retreatBelowHpPercent: 20 });
	const expectedFirstPolicy = policyValues({
		rallyNewUnitsToDefense: true,
		autoRepairBuildings: true,
		retreatBelowHpPercent: 35
	});
	const expectedSecondPolicy = policyValues({ defendCriticalAssets: true, retreatBelowHpPercent: 20 });
	staged = await call('StageAgentPlanningActions', successful.agentIds[0], JSON.stringify(planningBatch([
		{
			type: 'queueBuildPlan',
			planId: 'cp3-opening',
			version: 1,
			reserveCash: 500,
			steps: [{ item: 'powr', count: 1 }]
		},
		firstPolicy
	])));
	assert(staged.accepted === 2 && staged.results.every(result => result.accepted),
		`first seat planning batch did not stage: ${JSON.stringify(staged)}`);
	staged = await call('StageAgentPlanningActions', successful.agentIds[1],
		JSON.stringify(planningBatch([secondPolicy])));
	assert(staged.accepted === 1 && staged.results[0]?.accepted,
		`second seat planning batch did not stage: ${JSON.stringify(staged)}`);
	assert(JSON.parse(await exported('LaunchPreparedAgentMatch', successful.matchId)).launched === true,
		'prepared success match did not launch');
	await expectError('StageAgentPlanningActions', [successful.agentIds[0],
		JSON.stringify(planningBatch([]))], 'not accepting prematch planning actions');

	const successfulWarmup = await waitForMappedWarmup(
		'valid planning maps both seats and applies plan/policy evidence at warmup without OOS',
		successful, observations =>
			observations[0].hostTruth.buildPlan?.planId === 'cp3-opening' &&
			policyMatches(observations[0].hostTruth.standingPolicy, expectedFirstPolicy) &&
			policyMatches(observations[1].hostTruth.standingPolicy, expectedSecondPolicy));
	const [firstLive, secondLive] = successfulWarmup.observations;
	assertLiveContinuity(successful, successfulPlanning, [firstLive, secondLive]);
	const livePlan = firstLive.hostTruth.buildPlan;
	assert(livePlan?.planId === 'cp3-opening' && livePlan.version === 1 && livePlan.active === true &&
		livePlan.reserveCash === 500 && livePlan.currentStep?.item === 'powr',
		`staged build plan was not applied: ${JSON.stringify(livePlan)}`);
	assertPolicy(firstLive.hostTruth.standingPolicy, expectedFirstPolicy,
		'first seat planned policy was not applied');
	assertPolicy(secondLive.hostTruth.standingPolicy, expectedSecondPolicy,
		'second seat planned policy was not applied');
	assert(secondLive.hostTruth.buildPlan == null,
		`first seat build plan leaked to the second seat: ${JSON.stringify(secondLive.hostTruth.buildPlan)}`);
	const buildEvents = await call('GetAgentBuildPlanEvents', successful.agentIds[0], 0);
	assert(buildEvents.events.some(event => event.planId === 'cp3-opening' && event.state === 'planned' &&
		event.worldTick >= 25), `warmup plan event is missing: ${JSON.stringify(buildEvents)}`);
	assert(buildEvents.events.some(event => event.planId === 'cp3-opening' && event.state === 'waitingPrerequisites'),
		`TickBuildPlan did not run after staged application: ${JSON.stringify(buildEvents)}`);
	console.log('OK valid plan and policies apply before normal host controllers at warmup');

	// Decision 0 is reserved and consumed by planning. The first normal decision
	// is 1 and must be accepted with the normal live observation identity.
	await expectError('SubmitAgentActions', [successful.agentIds[0],
		JSON.stringify(gameplayBatch(firstLive, 0))], 'duplicate or out-of-order decisionId 0');
	const decisionOne = await call('SubmitAgentActions', successful.agentIds[0],
		JSON.stringify(gameplayBatch(firstLive, 1)));
	assert(decisionOne.decisionId === 1 && decisionOne.accepted === 0 && decisionOne.rejected === 0,
		`normal decision 1 failed after planning: ${JSON.stringify(decisionOne)}`);
	await readState();
	console.log('OK planning consumes decision 0 and normal decisions start at 1');
	await stopMatch('successful-planning');

	// Legacy StartAgentMatch remains one-shot: it prepares and launches internally
	// with planning disabled by default.
	const legacy = await call('StartAgentMatch', '', JSON.stringify({
		schemaVersion: 1,
		fakeAgents: false,
		decisionIntervalTicks: 500,
		faction1: 'russia',
		faction2: 'england'
	}));
	assert(legacy.prematchPlanning === false && legacy.planningTimeoutMs === 30_000 &&
		Array.isArray(legacy.agentIds) && legacy.agentIds.length === 2,
		`legacy StartAgentMatch result is invalid: ${JSON.stringify(legacy)}`);
	const legacyWarmup = await waitForMappedWarmup(
		'legacy StartAgentMatch maps both seats and launches directly without OOS', legacy);
	const legacyObservation = legacyWarmup.observations[0];
	const legacyDecision = await call('SubmitAgentActions', legacy.agentIds[0],
		JSON.stringify(gameplayBatch(legacyObservation, 1)));
	assert(legacyDecision.decisionId === 1 && legacyDecision.rejected === 0,
		`legacy normal decision failed: ${JSON.stringify(legacyDecision)}`);
	const legacyState = await readState();
	assert(!legacyState.outOfSync && legacyState.netFrame > 0,
		`legacy match lockstep state is invalid: ${JSON.stringify(legacyState)}`);
	await stopMatch('legacy');

	console.log('CP3 PLANNING LIFECYCLE GATE RESULT: PASS');
} catch (error) {
	console.error('CP3 PLANNING LIFECYCLE GATE FAILED:', error.message);
	process.exitCode = 1;
} finally {
	try {
		await page?.evaluate(() => globalThis.ora?.StopAgentMatch());
	} catch {
		// Preserve the primary failure.
	}
	process.removeListener('SIGINT', onSigint);
	process.removeListener('SIGTERM', onSigterm);
	await cleanup();
}
