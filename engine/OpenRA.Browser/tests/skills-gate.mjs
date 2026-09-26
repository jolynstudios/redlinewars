// Era 3 CP1 browser gate: contract identity, bounded military missions, fog
// safety, commander override, and terminal lockstep integrity.
//
// This gate uses only the public Agent mode API and synchronized typed orders.
// It deliberately contains no test-only world mutation surface.
// Usage: node skills-gate.mjs [--headed]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from '../agent-sidecar/node_modules/zod/index.js';
import {
	AgentActionBatchSchema,
	AgentActionSchema,
	PlanningActionSchema
} from '../agent-sidecar/dist/contracts.js';
import {
	buildContractManifest,
	buildProviderSurfaceManifest,
	fingerprintContractManifest
} from '../agent-sidecar/dist/contract-manifest.js';
import { RulesKnowledgeHash } from '../agent-sidecar/dist/instructions.js';
import { providerSafeSchema } from '../agent-sidecar/dist/provider-schema.js';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const contractOnly = args.includes('--contract-only');
const unknownArgs = args.filter(arg => arg !== '--headed' && arg !== '--contract-only');
if (unknownArgs.length !== 0) {
	console.error(`Unknown argument(s): ${unknownArgs.join(', ')}`);
	console.error('Usage: node skills-gate.mjs [--headed] [--contract-only]');
	process.exit(2);
}

const port = 8362;
const serverUrl = `http://127.0.0.1:${port}/`;
const url = `${serverUrl}index.html?mode=game&platform=webgl2&Host.DevContent=1&Host.AgentMode=1&` +
	'Launch.Map=Siberian-Pass.oramap&Debug.ServerRandomSeed=45678';
const MaxObservationBytes = 256 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let browser;
let page;
let cleanupPromise;
let agentId;
let otherAgentId;
const decisionIds = new Map();

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

async function probe(target, timeoutMs = 500) {
	try {
		const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
		await response.body?.cancel();
		return response.status;
	} catch {
		return null;
	}
}

async function stopChild(child) {
	if (child == null || child.exitCode != null || child.signalCode != null) {
		return;
	}

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
		if (startup.error != null) {
			throw new Error(`Could not start the bundle server: ${startup.error.message}`);
		}

		if (child.exitCode != null || child.signalCode != null) {
			throw new Error(`Bundle server exited before readiness: ${startup.stderr.trim().slice(-500)}`);
		}

		if (startup.listening && await probe(serverUrl) === 200) {
			return;
		}

		await delay(100);
	}

	throw new Error(`Bundle server did not become ready at ${serverUrl} within 10 seconds.`);
}

async function raw(method, ...args) {
	const text = await page.evaluate(({ method, args }) => globalThis.ora[method](...args), { method, args });
	return { text, value: JSON.parse(text) };
}

async function call(method, ...args) {
	const result = await raw(method, ...args);
	if (result.value?.error) {
		throw new Error(`${method}: ${result.value.error}`);
	}

	return result.value;
}

async function state() {
	const value = await call('GetAgentMatchState');
	if (value.outOfSync) {
		throw new Error(`DESYNC at tick ${value.worldTick}, net ${value.netFrame}`);
	}

	if (value.state === 'failed') {
		throw new Error(`Agent match failed: ${value.terminalReason ?? value.fakeAgentStatus}`);
	}

	return value;
}

async function waitFor(label, predicate, timeoutMs = 180_000, intervalMs = 100) {
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

async function observation(id = agentId) {
	const result = await raw('GetAgentObservation', id, 0);
	if (result.value?.error) {
		throw new Error(`GetAgentObservation: ${result.value.error}`);
	}

	const bytes = Buffer.byteLength(result.text, 'utf8');
	assert(bytes < MaxObservationBytes, `observation is ${bytes} bytes (limit ${MaxObservationBytes})`);
	assert(Array.isArray(result.value.hostTruth?.missions) && result.value.hostTruth.missions.length <= 3,
		`mission host truth is missing or unbounded: ${JSON.stringify(result.value.hostTruth?.missions)}`);
	assert(Array.isArray(result.value.situations) && result.value.situations.length <= 5,
		`situation state is missing or unbounded: ${JSON.stringify(result.value.situations)}`);
	assert(new Set(result.value.situations.map(situation => situation.key)).size === result.value.situations.length,
		`situation keys are not unique: ${JSON.stringify(result.value.situations)}`);
	for (const situation of result.value.situations) {
		assert(Number.isInteger(situation.sinceTick) && Number.isInteger(situation.lastUpdatedTick) &&
			situation.sinceTick <= situation.lastUpdatedTick && situation.lastUpdatedTick <= result.value.worldTick,
			`situation lifecycle is invalid: ${JSON.stringify(situation)}`);
		assert(Buffer.byteLength(JSON.stringify(situation), 'utf8') <= 4096,
			`situation payload is unbounded: ${JSON.stringify(situation)}`);
	}
	await state();
	return result.value;
}

function nextDecisionId(id) {
	const next = (decisionIds.get(id) ?? 0) + 1;
	decisionIds.set(id, next);
	return next;
}

function batchFor(id, obs, actions, thoughts = 'Era 3 deterministic scripted gate action.') {
	return {
		schemaVersion: 1,
		decisionId: nextDecisionId(id),
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts,
		memo: '',
		actions
	};
}

async function submitFor(id, actions, thoughts) {
	const obs = await observation(id);
	const value = await call('SubmitAgentActions', id, JSON.stringify(batchFor(id, obs, actions, thoughts)));
	assert(Array.isArray(value.results) && value.results.length === actions.length,
		`unexpected action results: ${JSON.stringify(value)}`);
	return value;
}

async function submitOne(id, action, thoughts) {
	const result = await submitFor(id, [action], thoughts);
	return result.results[0];
}

async function submitRawFor(id, actions, thoughts) {
	const obs = await observation(id);
	return raw('SubmitAgentActions', id, JSON.stringify(batchFor(id, obs, actions, thoughts)));
}

async function missionEvents(id, sinceSequence = 0) {
	const result = await raw('GetAgentMissionEvents', id, sinceSequence);
	if (result.value?.error) {
		throw new Error(`GetAgentMissionEvents: ${result.value.error}`);
	}

	const value = result.value;
	assert(value.schemaVersion === 1 && Number.isInteger(value.latestSequence) && Array.isArray(value.events),
		`mission-event contract is invalid: ${JSON.stringify(value)}`);
	assert(value.events.length <= 128, `mission event history is unbounded: ${value.events.length}`);
	assert(Buffer.byteLength(result.text, 'utf8') < 64 * 1024,
		`mission event payload is unbounded: ${Buffer.byteLength(result.text, 'utf8')} bytes`);
	let previousSequence = sinceSequence;
	for (const event of value.events) {
		assert(event.sequence > previousSequence,
			`mission event sequences are replayed or non-monotonic: ${JSON.stringify(value.events)}`);
		assert(typeof event.kind === 'string' && event.kind.length > 0 && event.kind.length <= 32,
			`mission event kind is missing or unbounded: ${JSON.stringify(event)}`);
		assert(typeof event.missionId === 'string' && event.missionId.length > 0 && event.missionId.length <= 32,
			`mission event missionId is missing or unbounded: ${JSON.stringify(event)}`);
		previousSequence = event.sequence;
	}
	return value;
}

function findQueue(obs, item) {
	return obs.productionQueues.find(queue => queue.buildableItems.includes(item));
}

async function waitForReadyBuilding(id, item) {
	return waitFor(`${item} becomes placeable`, async () => {
		const obs = await observation(id);
		const queue = findQueue(obs, item);
		return queue?.items.some(entry => entry.item === item && entry.placeable) ? { obs, queue } : false;
	}, 240_000, 150);
}

async function buildAndPlace(id, item) {
	const obs = await waitFor(`${item} becomes buildable`, async () => {
		const candidate = await observation(id);
		return findQueue(candidate, item) != null ? candidate : false;
	});
	const queue = findQueue(obs, item);
	let result = await submitOne(id, {
		type: 'startProduction', producerId: queue.producerId, item, count: 1, queued: false
	});
	assert(result.accepted, `startProduction ${item} rejected: ${result.reason}`);
	const ready = await waitForReadyBuilding(id, item);
	result = await submitOne(id, { type: 'placeBuildingAuto', producerId: ready.queue.producerId, item });
	assert(result.accepted, `placeBuildingAuto ${item} rejected: ${result.reason}`);
	return waitFor(`${item} actor appears`, async () => {
		const candidate = await observation(id);
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === item)
			? candidate : false;
	});
}

async function bootstrapInfantry(id, count) {
	let obs = await observation(id);
	const mcv = obs.actors.find(actor => actor.relationship === 'self' && actor.capabilities.includes('deploy'));
	assert(mcv != null, 'no deployable MCV was observed');
	let result = await submitOne(id, { type: 'deploy', actorIds: [mcv.actorId] });
	assert(result.accepted, `MCV deploy rejected: ${result.reason}`);
	await waitFor('Construction Yard appears', async () => {
		const candidate = await observation(id);
		return candidate.base.yards.length !== 0 ? candidate : false;
	});
	result = await submitOne(id, { type: 'deploy', actorIds: [mcv.actorId] });
	assert(result.accepted && /deploy already completed/.test(result.reason),
		`stale completed MCV deploy was not idempotent: ${JSON.stringify(result)}`);
	console.log('OK stale completed MCV deploy is narrowly idempotent');
	await buildAndPlace(id, 'powr');
	await buildAndPlace(id, 'barr');

	obs = await waitFor('infantry queue becomes available', async () => {
		const candidate = await observation(id);
		return findQueue(candidate, 'e1') != null ? candidate : false;
	});
	const queue = findQueue(obs, 'e1');
	const beforeIds = new Set(obs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1')
		.map(actor => actor.actorId));
	result = await submitOne(id, {
		type: 'startProduction', producerId: queue.producerId, item: 'e1', count, queued: false
	});
	assert(result.accepted, `infantry production rejected: ${result.reason}`);
	return waitFor(`${count} infantry appear`, async () => {
		const candidate = await observation(id);
		const infantry = candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1' &&
			!beforeIds.has(actor.actorId)).sort((a, b) => a.actorId - b.actorId);
		return infantry.length >= count ? { obs: candidate, infantry: infantry.slice(0, count) } : false;
	}, 240_000, 150);
}

function clampCell(obs, cell) {
	return {
		x: Math.max(obs.mapMinX, Math.min(obs.mapMaxX, cell.x)),
		y: Math.max(obs.mapMinY, Math.min(obs.mapMaxY, cell.y))
	};
}

function shiftedCell(obs, origin, dx, dy) {
	let cell = clampCell(obs, { x: origin.x + dx, y: origin.y + dy });
	if (cell.x === 0) {
		cell = clampCell(obs, { x: 1, y: cell.y });
	}
	if (cell.y === 0) {
		cell = clampCell(obs, { x: cell.x, y: 1 });
	}
	return cell;
}

function mission(obs, missionId) {
	return obs.hostTruth.missions.find(item => item.missionId === missionId);
}

function actorCentroid(actors) {
	return {
		x: Math.floor(actors.reduce((sum, actor) => sum + actor.cellX, 0) / actors.length),
		y: Math.floor(actors.reduce((sum, actor) => sum + actor.cellY, 0) / actors.length)
	};
}

async function cancelMission(id, missionId, missionVersion) {
	const active = mission(await observation(id), missionId);
	if (active == null) {
		return;
	}

	const result = await submitOne(id, {
		type: 'controlMission', missionId, missionVersion, missionCommand: 'cancel'
	});
	assert(result.accepted, `mission ${missionId} cancellation rejected: ${result.reason}`);
	await waitFor(`${missionId} releases its roster`, async () => {
		const candidate = await observation(id);
		return mission(candidate, missionId) == null ? candidate : false;
	}, 30_000, 50);
}

function assertFogSafeMissionPayload(events, ownActorIds, hiddenEnemyId) {
	for (const event of events) {
		assert(event.actorIds.every(actorId => ownActorIds.has(actorId)),
			`mission event leaked a non-own actor id: ${JSON.stringify(event)}`);
		assert(!Object.hasOwn(event, 'targetActorId'), `mission event exposed targetActorId: ${JSON.stringify(event)}`);
		assert((event.reason ?? '').length <= 160, `mission event reason is unbounded: ${JSON.stringify(event)}`);
		if (event.cell != null) {
			assert(Number.isInteger(event.cell.x) && Number.isInteger(event.cell.y),
				`mission event cell is invalid: ${JSON.stringify(event)}`);
		}
	}

	assert(!events.some(event => event.actorIds.includes(hiddenEnemyId)),
		`hidden enemy actor ${hiddenEnemyId} appeared in mission events`);
}

async function contractFingerprintPreflight() {
	const rawSchema = z.toJSONSchema(AgentActionSchema);
	const rawBatchSchema = z.toJSONSchema(AgentActionBatchSchema);
	const rawPlanningSchema = z.toJSONSchema(PlanningActionSchema);
	const providerSchema = providerSafeSchema(rawSchema);
	const rawManifest = buildContractManifest(rawSchema, rawBatchSchema, 'era3-skills', rawPlanningSchema,
		RulesKnowledgeHash);
	const rawProviderSurface = buildProviderSurfaceManifest(rawSchema, 'era3-skills');
	const providerManifest = buildProviderSurfaceManifest(providerSchema, 'era3-skills');
	const rawFingerprint = fingerprintContractManifest(rawManifest);
	assert(JSON.stringify(rawProviderSurface) === JSON.stringify(providerManifest),
		`provider schema surface drifted from Zod:\nraw=${JSON.stringify(rawProviderSurface)}\n` +
		`provider=${JSON.stringify(providerManifest)}`);

	const host = await call('GetAgentContractManifest');
	if (host.fingerprint !== rawFingerprint) {
		console.error(`host manifest: ${JSON.stringify(host.manifest)}`);
		console.error(`Zod manifest: ${JSON.stringify(rawManifest)}`);
	}
	assert(host.fingerprint === rawFingerprint,
		`host/Zod contract fingerprint mismatch: host=${host.fingerprint}, zod=${rawFingerprint}`);
	assert(JSON.stringify(host.manifest) === JSON.stringify(rawManifest),
		`host/Zod canonical manifests differ:\nhost=${JSON.stringify(host.manifest)}\nzod=${JSON.stringify(rawManifest)}`);
	assert(rawManifest.benchmarkSpecVersion === 'benchmark-lockstep-v1',
		`benchmark spec pin drifted: ${rawManifest.benchmarkSpecVersion}`);
	for (const field of [
		'benchmarkControlRegions:array<{id,cells[{x,y}]}> maxRegions=64 maxCells=4096 default=[]',
		'benchmarkLockstepEnabled:boolean default=false',
		'benchmarkSpecVersion:literal benchmark-lockstep-v1',
		'benchmarkDecisionTimeoutMs:integer range=10000..120000 default=120000',
		'benchmarkTickHorizon:integer min=0 default=0',
		'benchmarkDecisionHorizon:integer min=0 default=0'
	]) {
		assert(rawManifest.configSurface.includes(field),
			`benchmark config surface is missing '${field}'`);
	}
	assert(rawManifest.matchStateFields.includes('adjudication'),
		'benchmark adjudication telemetry is missing from match state');
	const lockstepExports = await page.evaluate(() => [
		'GetAgentLockstepBarrier', 'CommitAgentLockstepBarrier', 'AbortAgentLockstepBarrier'
	].map(name => [name, typeof globalThis.ora?.[name]]));
	assert(lockstepExports.every(([, type]) => type === 'function'),
		`public lockstep API is incomplete: ${JSON.stringify(lockstepExports)}`);
	console.log(`OK host/Zod/provider contract fingerprint ${rawFingerprint}`);
	console.log(`OK ${rawManifest.benchmarkSpecVersion} manifest pin and public barrier API`);
}

try {
	if (await probe(serverUrl) != null) {
		throw new Error(`Port ${port} is already serving HTTP; refusing to adopt an unowned bundle server.`);
	}

	const startup = { listening: false, stderr: '', error: null };
	server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(port)], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.once('error', error => { startup.error = error; });
	server.stdout.on('data', chunk => {
		if (String(chunk).includes('[server] serving ')) {
			startup.listening = true;
		}
	});
	server.stderr.on('data', chunk => {
		startup.stderr = `${startup.stderr}${String(chunk)}`.slice(-2000);
	});
	await waitForOwnedServer(server, startup);

	browser = await chromium.launch({ headless: !headed });
	page = await browser.newPage();
	page.on('pageerror', error => console.error('[pageerror]', String(error)));
	page.on('console', message => {
		if (/\[host\]|FATAL|agent|PASS|FAIL/i.test(message.text())) {
			console.log(`[console] ${message.text().slice(0, 240)}`);
		}
	});
	await page.goto(url);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } },
		undefined, { timeout: 60_000 });

	await contractFingerprintPreflight();
	if (contractOnly) {
		console.log('SKILLS CONTRACT GATE RESULT: PASS');
	} else {
	const schema = await call('GetAgentActionSchema');
	assert(schema.era === 'era3-skills' && schema.contractFingerprint != null,
		`action schema is not stamped era3-skills: ${JSON.stringify(schema).slice(0, 500)}`);
	for (const type of ['queueMission', 'controlMission', 'guard', 'spyPlane']) {
		assert(schema.actions.some(action => action.type === type), `${type} is missing from the host action schema`);
	}

	const started = await call('StartAgentMatch', '', JSON.stringify({
		schemaVersion: 1,
		fakeAgents: false,
		decisionIntervalTicks: 500,
		faction1: 'russia',
		faction2: 'russia'
	}));
	assert(started.era === 'era3-skills' && started.agentIds.length === 2,
		`unexpected CP1 match start: ${JSON.stringify(started)}`);
	[agentId, otherAgentId] = started.agentIds;
	const runningState = await waitFor('regular Era 3 world', async () => {
		const current = await state();
		return current.state === 'running' && current.worldTick >= 25 ? current : false;
	});

	const hiddenEnemyObservation = await observation(otherAgentId);
	const hiddenEnemy = hiddenEnemyObservation.actors.find(actor => actor.relationship === 'self');
	assert(hiddenEnemy != null, 'second agent has no initial actor for the fog audit');
	const initial = await observation(agentId);
	const firstSeat = runningState.agents.find(agent => agent.agentId === agentId);
	assert(firstSeat?.playerColor === initial.player.color && firstSeat?.seatIdentity === initial.player.seatIdentity,
		`authoritative seat color/identity diverged: state=${JSON.stringify(firstSeat)} player=${JSON.stringify(initial.player)}`);
	console.log('OK spectator/log seat color and identity match authoritative player state');
	assert(!initial.actors.some(actor => actor.relationship === 'enemy' && actor.actorId === hiddenEnemy.actorId),
		'first agent could see the second agent before scouting');
	assert(initial.situations.some(situation => situation.id === 'E1.funding'),
		`factual funding situation is missing: ${JSON.stringify(initial.situations)}`);
	assert(!initial.situations.some(situation => situation.id.startsWith('T1.') || situation.id === 'O2'),
		`hidden enemy facts leaked into situations: ${JSON.stringify(initial.situations)}`);
	console.log('OK persistent situation state is bounded and fog-safe before contact');

	let invalid = await submitRawFor(agentId, [
		{
			type: 'queueMission', missionId: 'too-many-a', missionType: 'sweep', missionVersion: 1,
			groupName: 'missing-a', exploredPercentTarget: 100, abortLossPercent: 50
		},
		{
			type: 'controlMission', missionId: 'too-many-b', missionVersion: 1, missionCommand: 'pause'
		}
	]);
	assert(invalid.value.error?.includes('at most one mission action'),
		`mission cardinality was not rejected wholesale: ${invalid.text}`);
	console.log('OK mission batch cardinality rejects before mutation');

	const fixture = await bootstrapInfantry(agentId, 5);
	const scouts = fixture.infantry.slice(0, 2);
	const strikers = fixture.infantry.slice(2);
	let result = await submitOne(agentId, {
		type: 'assignGroup', name: 'cp1-scouts', actorIds: scouts.map(actor => actor.actorId)
	});
	assert(result.accepted, `scout group rejected: ${result.reason}`);
	result = await submitOne(agentId, {
		type: 'assignGroup', name: 'cp1-strike', actorIds: strikers.map(actor => actor.actorId)
	});
	assert(result.accepted, `strike group rejected: ${result.reason}`);
	for (let index = 0; index < 4; index++) {
		result = await submitOne(agentId, {
			type: 'assignGroup', name: `cp1-limit-${index + 1}`, actorIds: [fixture.infantry[index].actorId]
		});
		assert(result.accepted, `mission-limit group ${index + 1} rejected: ${result.reason}`);
	}
	for (let index = 0; index < 3; index++) {
		result = await submitOne(agentId, {
			type: 'queueMission', missionId: `limit-${index + 1}`, missionType: 'sweep', missionVersion: 1,
			groupName: `cp1-limit-${index + 1}`, exploredPercentTarget: 100, abortLossPercent: 50
		});
		assert(result.accepted, `active mission ${index + 1} rejected: ${result.reason}`);
	}
	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'limit-4', missionType: 'sweep', missionVersion: 1,
		groupName: 'cp1-limit-4', exploredPercentTarget: 100, abortLossPercent: 50
	});
	assert(!result.accepted && result.reason.includes('at most 3 missions may be active'),
		`fourth active mission was not rejected: ${JSON.stringify(result)}`);
	for (let index = 0; index < 3; index++) {
		result = await submitOne(agentId, {
			type: 'controlMission', missionId: `limit-${index + 1}`, missionVersion: 1, missionCommand: 'cancel'
		});
		assert(result.accepted, `mission-limit cleanup ${index + 1} rejected: ${result.reason}`);
	}
	console.log('OK active mission cardinality is bounded at three');

	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'bad-purity', missionType: 'sweep', missionVersion: 1,
		groupName: 'cp1-scouts', exploredPercentTarget: 100, abortLossPercent: 50,
		producerId: 1
	});
	assert(!result.accepted && result.reason.includes('fields for a different action type'),
		`mission field purity changed: ${JSON.stringify(result)}`);

	const scoutStart = new Map(scouts.map(actor => [actor.actorId, `${actor.cellX},${actor.cellY}`]));
	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'map-sweep', missionType: 'sweep', missionVersion: 1,
		groupName: 'cp1-scouts', exploredPercentTarget: 100, abortLossPercent: 50
	});
	assert(result.accepted && result.reason === "accepted; mission 'map-sweep' v1 queued",
		`sweep mission rejected: ${JSON.stringify(result)}`);

	let obs = await waitFor('sweep transitions and moves through synchronized orders', async () => {
		const candidate = await observation(agentId);
		const active = mission(candidate, 'map-sweep');
		const moved = scouts.some(actor => {
			const current = candidate.actors.find(item => item.actorId === actor.actorId);
			return current != null && `${current.cellX},${current.cellY}` !== scoutStart.get(actor.actorId);
		});
		return active?.state === 'sweeping' && moved ? candidate : false;
	}, 120_000, 100);
	assert(mission(obs, 'map-sweep').legs[0].alive === 2, 'sweep mission did not snapshot the group roster');

	let events = await missionEvents(agentId);
	assert(events.events.some(event => event.missionId === 'map-sweep' && event.state === 'planned') &&
		events.events.some(event => event.missionId === 'map-sweep' && event.state === 'sweeping'),
		`sweep lifecycle events are missing: ${JSON.stringify(events)}`);
	const firstCursor = events.latestSequence;
	const emptyCursor = await missionEvents(agentId, firstCursor);
	assert(emptyCursor.latestSequence >= firstCursor &&
		emptyCursor.events.every(event => event.sequence > firstCursor),
		`mission event cursor replayed old events: ${JSON.stringify(emptyCursor)}`);

	const releasedScout = obs.actors.find(actor => actor.actorId === scouts[0].actorId);
	const releaseTarget = shiftedCell(obs, { x: releasedScout.cellX, y: releasedScout.cellY }, 1, 1);
	let batchResult = await submitFor(agentId, [
		{
			type: 'queueMission', missionId: 'map-sweep', missionType: 'sweep', missionVersion: 2,
			groupName: 'cp1-scouts', exploredPercentTarget: 100, abortLossPercent: 50
		},
		{
			type: 'move', actorIds: [releasedScout.actorId], cellX: releaseTarget.x, cellY: releaseTarget.y, queued: false
		}
	], 'Replace the sweep, but directly command one scout in the same batch.');
	assert(batchResult.results.every(item => item.accepted),
		`mission-first commander override batch rejected: ${JSON.stringify(batchResult)}`);
	obs = await waitFor('direct order releases an actor from its mission', async () => {
		const candidate = await observation(agentId);
		const active = mission(candidate, 'map-sweep');
		return active?.missionVersion === 2 && active.legs[0].alive === 1 ? candidate : false;
	}, 20_000, 50);
	events = await missionEvents(agentId, firstCursor);
	assert(events.events.some(event => event.missionId === 'map-sweep' &&
		event.actorIds.includes(releasedScout.actorId) && event.reason.includes('commander override')),
		`mission release was not attributed: ${JSON.stringify(events)}`);

	const otherScout = obs.actors.find(actor => actor.actorId === scouts[1].actorId);
	const otherTarget = shiftedCell(obs, { x: otherScout.cellX, y: otherScout.cellY }, -1, 1);
	batchResult = await submitFor(agentId, [
		{
			type: 'move', actorIds: [otherScout.actorId], cellX: otherTarget.x, cellY: otherTarget.y, queued: false
		},
		{
			type: 'queueMission', missionId: 'map-sweep', missionType: 'sweep', missionVersion: 3,
			groupName: 'cp1-scouts', exploredPercentTarget: 100, abortLossPercent: 50
		}
	], 'Directly command one scout before replacing the sweep in the same batch.');
	assert(batchResult.results.every(item => item.accepted),
		`order-first commander override batch rejected: ${JSON.stringify(batchResult)}`);
	await waitFor('direct-order precedence is independent of batch order', async () => {
		const candidate = await observation(agentId);
		const active = mission(candidate, 'map-sweep');
		return active?.missionVersion === 3 && active.legs[0].alive === 1 ? candidate : false;
	}, 20_000, 50);
	console.log('OK direct model order beats mission ownership in either batch order');

	result = await submitOne(agentId, {
		type: 'controlMission', missionId: 'map-sweep', missionVersion: 3, missionCommand: 'pause'
	});
	assert(result.accepted, `sweep pause rejected: ${result.reason}`);
	const pauseState = await state();
	await waitFor('pause issues a synchronized stop before resume', async () => {
		const candidate = await observation(agentId);
		const actor = candidate.actors.find(item => item.actorId === releasedScout.actorId);
		return candidate.worldTick >= pauseState.worldTick + 5 && mission(candidate, 'map-sweep')?.paused && actor?.idle
			? candidate : false;
	}, 20_000, 50);
	result = await submitOne(agentId, {
		type: 'controlMission', missionId: 'map-sweep', missionVersion: 3, missionCommand: 'resume'
	});
	assert(result.accepted, `sweep resume rejected: ${result.reason}`);
	result = await submitOne(agentId, {
		type: 'controlMission', missionId: 'map-sweep', missionVersion: 3, missionCommand: 'cancel'
	});
	assert(result.accepted, `sweep cancel rejected: ${result.reason}`);
	await waitFor('cancelled sweep releases its roster', async () => {
		const candidate = await observation(agentId);
		return mission(candidate, 'map-sweep') == null ? candidate : false;
	}, 30_000, 50);

	obs = await observation(agentId);
	const strikeActors = strikers.map(actor => obs.actors.find(item => item.actorId === actor.actorId))
		.filter(actor => actor != null);
	assert(strikeActors.length === 3, 'strike roster was lost before mission submission');
	const centroid = {
		x: Math.floor(strikeActors.reduce((sum, actor) => sum + actor.cellX, 0) / strikeActors.length),
		y: Math.floor(strikeActors.reduce((sum, actor) => sum + actor.cellY, 0) / strikeActors.length)
	};
	const directionX = centroid.x < (obs.mapMinX + obs.mapMaxX) / 2 ? 1 : -1;
	const via = shiftedCell(obs, centroid, directionX * 3, 2);
	const target = shiftedCell(obs, centroid, directionX * 9, 4);
	const strikeStart = new Map(strikeActors.map(actor => [actor.actorId, `${actor.cellX},${actor.cellY}`]));
	for (const legs of [[], [
		{ squad: 'cp1-strike', viaX: via.x, viaY: via.y },
		{ squad: 'cp1-strike', viaX: via.x, viaY: via.y }
	]]) {
		result = await submitOne(agentId, {
			type: 'queueMission', missionId: `bad-legs-${legs.length}`, missionType: 'strike', missionVersion: 1,
			cellX: target.x, cellY: target.y, legs,
			posture: 'raid', targetPriority: 'production', abortLossPercent: 40
		});
		assert(!result.accepted && result.reason.includes('exactly one leg'),
			`strike with ${legs.length} legs was accepted: ${JSON.stringify(result)}`);
	}
	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'one-leg-strike', missionType: 'strike', missionVersion: 1,
		cellX: target.x, cellY: target.y,
		legs: [{ squad: 'cp1-strike', viaX: via.x, viaY: via.y }],
		posture: 'raid', targetPriority: 'production', abortLossPercent: 40
	});
	assert(result.accepted, `one-leg strike rejected: ${result.reason}`);

	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'overlap-check', missionType: 'sweep', missionVersion: 1,
		groupName: 'cp1-strike', exploredPercentTarget: 100, abortLossPercent: 50
	});
	assert(!result.accepted && result.reason.includes("already committed to mission 'one-leg-strike'"),
		`overlapping mission roster was accepted: ${JSON.stringify(result)}`);

	obs = await waitFor('one-leg strike stages and advances through normal orders', async () => {
		const candidate = await observation(agentId);
		const active = mission(candidate, 'one-leg-strike');
		const moved = strikeActors.some(actor => {
			const current = candidate.actors.find(item => item.actorId === actor.actorId);
			return current != null && `${current.cellX},${current.cellY}` !== strikeStart.get(actor.actorId);
		});
		return active != null && active.state !== 'planned' && moved ? candidate : false;
	}, 120_000, 100);
	const strikeMission = mission(obs, 'one-leg-strike');
	assert(strikeMission.type === 'strike' && strikeMission.legs.length === 1 &&
		strikeMission.targetCell.x === target.x && strikeMission.targetCell.y === target.y,
		`strike host truth is invalid: ${JSON.stringify(strikeMission)}`);

	events = await missionEvents(agentId, 0);
	const ownActorIds = new Set((await observation(agentId)).actors
		.filter(actor => actor.relationship === 'self').map(actor => actor.actorId));
	assertFogSafeMissionPayload(events.events, ownActorIds, hiddenEnemy.actorId);
	assert(events.events.some(event => event.missionId === 'one-leg-strike' &&
		['staging', 'advancing', 'engaging', 'consolidating', 'retreating'].includes(event.state)),
		`strike lifecycle events are missing: ${JSON.stringify(events)}`);
	console.log('OK mission payload contains own facts and fog-safe cells only');

	// CP2 breadth starts from the same five synchronized infantry. Keeping the
	// fixture sequential avoids mission overlap, combat variance, and extra
	// production time while still exercising every state machine through real
	// orders in a world that never pauses.
	await cancelMission(agentId, 'one-leg-strike', 1);
	obs = await observation(agentId);
	let liveScouts = scouts.map(actor => obs.actors.find(item => item.actorId === actor.actorId)).filter(Boolean);
	let liveStrikers = strikers.map(actor => obs.actors.find(item => item.actorId === actor.actorId)).filter(Boolean);
	assert(liveScouts.length === 2 && liveStrikers.length === 3,
		'CP2 fixture lost infantry before pincer staging');
	const farCentroid = actorCentroid(liveStrikers);
	const pincerDirection = farCentroid.x < (obs.mapMinX + obs.mapMaxX) / 2 ? 1 : -1;
	const gatherCell = shiftedCell(obs, actorCentroid(liveScouts), pincerDirection * 2, 0);
	result = await submitOne(agentId, {
		type: 'move', actorIds: liveScouts.map(actor => actor.actorId),
		cellX: gatherCell.x, cellY: gatherCell.y, queued: false
	});
	assert(result.accepted, `pincer near-leg gather rejected: ${result.reason}`);
	obs = await waitFor('near pincer leg gathers before mission submission', async () => {
		const candidate = await observation(agentId);
		const current = liveScouts.map(actor => candidate.actors.find(item => item.actorId === actor.actorId)).filter(Boolean);
		return current.length === 2 && current.every(actor =>
			(actor.cellX - gatherCell.x) ** 2 + (actor.cellY - gatherCell.y) ** 2 <= 16) ? candidate : false;
	}, 60_000, 50);
	liveScouts = scouts.map(actor => obs.actors.find(item => item.actorId === actor.actorId)).filter(Boolean);
	const nearCentroid = actorCentroid(liveScouts);
	const nearVia = shiftedCell(obs, nearCentroid, 0, 0);
	const farVia = shiftedCell(obs, farCentroid, pincerDirection * 12, 4);
	const pincerTarget = shiftedCell(obs, farVia, pincerDirection * 8, -4);
	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'cp2-pincer', missionType: 'pincer', missionVersion: 1,
		cellX: pincerTarget.x, cellY: pincerTarget.y,
		legs: [
			{ squad: 'cp1-scouts', viaX: nearVia.x, viaY: nearVia.y },
			{ squad: 'cp1-strike', viaX: farVia.x, viaY: farVia.y }
		],
		posture: 'assault', targetPriority: 'any', abortLossPercent: 40
	});
	assert(result.accepted, `two-leg pincer rejected: ${result.reason}`);
	await waitFor('near pincer leg waits behind the staging barrier', async () => {
		const candidate = await observation(agentId);
		const active = mission(candidate, 'cp2-pincer');
		const nearLeg = active?.legs.find(leg => leg.squad === 'cp1-scouts');
		const farLeg = active?.legs.find(leg => leg.squad === 'cp1-strike');
		return active?.state === 'staging' && nearLeg?.staged && farLeg != null && !farLeg.staged
			? candidate : false;
	}, 30_000, 20);
	await waitFor('all pincer legs cross the barrier before advancing', async () => {
		const candidate = await observation(agentId);
		const active = mission(candidate, 'cp2-pincer');
		return active != null && active.legs.length === 2 && active.legs.every(leg => leg.staged) &&
			['advancing', 'engaging', 'consolidating'].includes(active.state) ? candidate : false;
	}, 120_000, 50);
	events = await missionEvents(agentId, 0);
	const pincerAdvancing = events.events.find(event =>
		event.missionId === 'cp2-pincer' && event.state === 'advancing');
	assert(pincerAdvancing != null && pincerAdvancing.reason === 'all legs staged; advancing together',
		`pincer did not record its synchronization barrier: ${JSON.stringify(events.events)}`);
	console.log('OK pincer near leg holds until the far leg stages');
	await cancelMission(agentId, 'cp2-pincer', 1);

	// Pursuit is deliberately pointed into an empty nearby cell. It must chase
	// through ordinary attack-move orders, then terminate after its bounded
	// contact-loss window instead of polling or following hidden actors.
	obs = await observation(agentId);
	liveScouts = scouts.map(actor => obs.actors.find(item => item.actorId === actor.actorId)).filter(Boolean);
	const pursueOrigin = actorCentroid(liveScouts);
	const pursueStart = new Map(liveScouts.map(actor => [actor.actorId, `${actor.cellX},${actor.cellY}`]));
	const pursueCell = shiftedCell(obs, pursueOrigin, pincerDirection * 8, -3);
	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'cp2-pursue', missionType: 'pursue', missionVersion: 1,
		groupName: 'cp1-scouts', cellX: pursueCell.x, cellY: pursueCell.y,
		maxChaseCells: 5, abortLossPercent: 30
	});
	assert(result.accepted, `pursue mission rejected: ${result.reason}`);
	await waitFor('pursue enters its chasing state', async () => {
		const candidate = await observation(agentId);
		return mission(candidate, 'cp2-pursue')?.state === 'chasing' ? candidate : false;
	}, 30_000, 50);
	await waitFor('pursue advances through synchronized attack-move orders', async () => {
		const candidate = await observation(agentId);
		return liveScouts.some(actor => {
			const current = candidate.actors.find(item => item.actorId === actor.actorId);
			return current != null && `${current.cellX},${current.cellY}` !== pursueStart.get(actor.actorId);
		}) ? candidate : false;
	}, 60_000, 50);
	await waitFor('pursue terminates after bounded contact loss', async () => {
		const batch = await missionEvents(agentId, 0);
		return batch.events.some(event => event.missionId === 'cp2-pursue' &&
			['completed', 'aborted'].includes(event.state) && /contact.*lost|no.*contact/i.test(event.reason))
			? batch : false;
	}, 120_000, 100);
	await waitFor('contact-lost pursuit releases its roster', async () => {
		const candidate = await observation(agentId);
		return mission(candidate, 'cp2-pursue') == null ? candidate : false;
	}, 30_000, 50);
	console.log('OK pursue stops at its fog-safe contact-loss boundary');

	// Move the reserve away first so reinforce must execute a real approach,
	// then require the arrival milestone and terminal release. The controller
	// uses Guard on the destination leader when supported; direct guard below
	// validates the same engine order boundary independently.
	obs = await observation(agentId);
	liveScouts = scouts.map(actor => obs.actors.find(item => item.actorId === actor.actorId)).filter(Boolean);
	liveStrikers = strikers.map(actor => obs.actors.find(item => item.actorId === actor.actorId)).filter(Boolean);
	const destinationCentroid = actorCentroid(liveStrikers);
	const reserveCell = shiftedCell(obs, destinationCentroid, -pincerDirection * 14, 10);
	result = await submitOne(agentId, {
		type: 'move', actorIds: liveScouts.map(actor => actor.actorId),
		cellX: reserveCell.x, cellY: reserveCell.y, queued: false
	});
	assert(result.accepted, `reinforcement staging move rejected: ${result.reason}`);
	await waitFor('reinforcement group separates from destination squad', async () => {
		const candidate = await observation(agentId);
		const current = liveScouts.map(actor => candidate.actors.find(item => item.actorId === actor.actorId)).filter(Boolean);
		return current.length === 2 && current.every(actor =>
			(actor.cellX - destinationCentroid.x) ** 2 + (actor.cellY - destinationCentroid.y) ** 2 > 36)
			? candidate : false;
	}, 60_000, 50);
	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'cp2-reinforce', missionType: 'reinforce', missionVersion: 1,
		groupName: 'cp1-scouts', destinationSquad: 'cp1-strike'
	});
	assert(result.accepted, `reinforce mission rejected: ${result.reason}`);
	await waitFor('reinforcements arrive and guard the destination squad', async () => {
		const batch = await missionEvents(agentId, 0);
		const arrived = batch.events.some(event => event.missionId === 'cp2-reinforce' &&
			(event.kind === 'reinforcementArrived' || /reinforcement.*arrived/i.test(event.reason)));
		const completed = batch.events.some(event => event.missionId === 'cp2-reinforce' && event.state === 'completed');
		return arrived && completed ? batch : false;
	}, 120_000, 100);
	await waitFor('reinforce terminal releases its roster', async () => {
		const candidate = await observation(agentId);
		return mission(candidate, 'cp2-reinforce') == null ? candidate : false;
	}, 30_000, 50);

	obs = await observation(agentId);
	const guardSubject = obs.actors.find(actor => actor.actorId === scouts[0].actorId);
	const guardTarget = obs.actors.find(actor => actor.actorId === strikers[0].actorId);
	assert(guardSubject != null && guardTarget != null, 'guard fixture actors disappeared');
	result = await submitOne(agentId, {
		type: 'guard', actorIds: [guardSubject.actorId], targetActorId: guardTarget.actorId
	});
	assert(result.accepted, `direct guard rejected: ${result.reason}`);
	result = await submitOne(agentId, {
		type: 'guard', actorIds: [guardSubject.actorId], targetActorId: hiddenEnemy.actorId
	});
	assert(!result.accepted && result.reason === 'guard target is stale, missing, or not owned/allied by this agent',
		`enemy/hidden guard target rejection changed: ${JSON.stringify(result)}`);
	console.log('OK reinforce arrival and direct Guard use validated synchronized orders');

	// Full-policy statement: every standing-order field is explicit. The gate
	// records the new default-off repair policy and its opt-in ledger state;
	// damage/repair execution remains covered by the synchronized combat gate.
	obs = await observation(agentId);
	assert(obs.hostTruth.standingPolicy.autoRepairBuildings === false,
		`autoRepairBuildings default changed: ${JSON.stringify(obs.hostTruth.standingPolicy)}`);
	result = await submitOne(agentId, {
		type: 'setPolicy',
		autoReturnFire: true,
		harvesterFlee: true,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: true,
		retreatBelowHpPercent: 0,
		autoRepairBuildings: true
	});
	assert(result.accepted && result.reason === 'accepted; standing orders updated',
		`auto-repair policy update rejected: ${JSON.stringify(result)}`);
	obs = await observation(agentId);
	assert(obs.hostTruth.standingPolicy.autoRepairBuildings === true,
		`auto-repair policy was not recorded in host truth: ${JSON.stringify(obs.hostTruth.standingPolicy)}`);

	// Support-power validation first proves the absent boundary. Building the
	// normal RA tech chain then exposes SovietSpyPlane while it is charging,
	// letting the gate validate the live remaining-seconds contract without
	// waiting several in-game minutes for activation.
	const supportTarget = shiftedCell(obs, actorCentroid([guardTarget]), pincerDirection * 6, 0);
	result = await submitOne(agentId, { type: 'spyPlane', cellX: supportTarget.x, cellY: supportTarget.y });
	assert(!result.accepted && result.reason === "support power 'SovietSpyPlane' is unavailable",
		`unavailable spy-plane rejection changed: ${JSON.stringify(result)}`);
	await buildAndPlace(agentId, 'proc');
	await buildAndPlace(agentId, 'dome');
	await buildAndPlace(agentId, 'afld');
	obs = await waitFor('Soviet spy plane appears in support-power host truth', async () => {
		const candidate = await observation(agentId);
		const power = candidate.hostTruth.supportPowers?.find(item => item.orderName === 'SovietSpyPlane');
		return power != null && !power.ready && Number.isInteger(power.remainingSeconds) && power.remainingSeconds > 0
			? candidate : false;
	}, 60_000, 50);
	const spyPlane = obs.hostTruth.supportPowers.find(item => item.orderName === 'SovietSpyPlane');
	result = await submitOne(agentId, { type: 'spyPlane', cellX: supportTarget.x, cellY: supportTarget.y });
	assert(!result.accepted && /^support power 'SovietSpyPlane' is charging; ~\d+s remain$/.test(result.reason),
		`charging spy-plane rejection changed: ${JSON.stringify(result)}`);
	const reportedSeconds = Number(result.reason.match(/~(\d+)s remain$/)?.[1]);
	assert(Number.isInteger(reportedSeconds) && Math.abs(reportedSeconds - spyPlane.remainingSeconds) <= 1,
		`spy-plane rejection did not reflect the observed charge: observed=${spyPlane.remainingSeconds}, result=${result.reason}`);

	// Air sorties require an aircraft production/rearm fixture and are not
	// cheap enough for this already long gate. The contract and its critical
	// aircraft-only ownership boundary remain runtime-enforced here.
	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'bad-air-roster', missionType: 'airStrike', missionVersion: 1,
		groupName: 'cp1-strike', cellX: supportTarget.x, cellY: supportTarget.y,
		sorties: 2, targetPriority: 'any', abortLossPercent: 50
	});
	assert(!result.accepted && result.reason ===
		`actor ${strikers[0].actorId} cannot participate in airStrike; an aircraft is required`,
		`airStrike aircraft-only validation changed: ${JSON.stringify(result)}`);
	console.log('OK support-power and airStrike validation boundaries');

	const terminalObservation = await observation(agentId);
	result = await submitOne(agentId, { type: 'surrender' }, 'End the CP1 lockstep fixture.');
	assert(result.accepted, `surrender rejected: ${result.reason}`);
	const terminal = await waitFor('surrender resolves the match without OOS', async () => {
		const candidate = await state();
		return candidate.state === 'finished' ? candidate : false;
	}, 60_000, 100);
	assert(!terminal.outOfSync && terminal.worldTick >= terminalObservation.worldTick && terminal.netFrame > 0,
		`terminal lockstep state is invalid: ${JSON.stringify(terminal)}`);
	assert(terminal.agents.find(agent => agent.agentId === agentId)?.winState === 'Lost' &&
		terminal.agents.find(agent => agent.agentId === otherAgentId)?.winState === 'Won',
		`terminal win states are wrong: ${JSON.stringify(terminal.agents)}`);
	console.log(`SKILLS GATE RESULT: PASS tick=${terminal.worldTick} net=${terminal.netFrame}`);
	}
} catch (error) {
	console.error('SKILLS GATE FAILED:', error.message);
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
