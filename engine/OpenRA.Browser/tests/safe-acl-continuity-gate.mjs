// Safe ACL adoption browser gate: doctrine scouting survives its phase exploration
// threshold without enemy-structure contact, direct sweeps retain threshold completion,
// and a model override receives the full 750-tick standing-scout cooldown.
//
// The second seat never receives a deploy action. Its MCV is moved away from the
// scouts when necessary so the match remains live without creating an enemy structure.
// Usage: node safe-acl-continuity-gate.mjs [--headed]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const headed = process.argv.includes('--headed');
const unknown = process.argv.slice(2).filter(arg => arg !== '--headed');
if (unknown.length !== 0) {
	console.error(`Unknown argument(s): ${unknown.join(', ')}`);
	process.exit(2);
}

const port = 8367;
const serverUrl = `http://127.0.0.1:${port}/`;
const gameUrl = `${serverUrl}index.html?mode=game&platform=webgl2&Host.DevContent=1&Host.AgentMode=1&` +
	'Launch.Map=ore-lord.oramap&Debug.ServerRandomSeed=71357';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const decisionIds = new Map();
let server;
let browser;
let page;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function probe(url, timeoutMs = 500) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
		await response.body?.cancel();
		return response.status;
	} catch {
		return null;
	}
}

async function stopChild(child) {
	if (child == null || child.exitCode != null || child.signalCode != null) return;
	const exited = new Promise(resolve => child.once('exit', resolve));
	child.kill('SIGTERM');
	await Promise.race([exited, delay(2000)]);
	if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
}

async function call(method, ...args) {
	const text = await page.evaluate(({ method, args }) => globalThis.ora[method](...args), { method, args });
	const value = JSON.parse(text);
	if (value?.error) throw new Error(`${method}: ${value.error}`);
	return value;
}

async function state() {
	const value = await call('GetAgentMatchState');
	assert(!value.outOfSync, `out of sync at tick ${value.worldTick}`);
	assert(value.state !== 'failed', `match failed: ${value.terminalReason}`);
	return value;
}

async function observation(agentId) {
	const value = await call('GetAgentObservation', agentId, 0);
	await state();
	return value;
}

function nextDecisionId(agentId) {
	const value = (decisionIds.get(agentId) ?? 0) + 1;
	decisionIds.set(agentId, value);
	return value;
}

async function submit(agentId, actions, thoughts = 'Safe ACL deterministic browser gate action.') {
	const obs = await observation(agentId);
	const value = await call('SubmitAgentActions', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: nextDecisionId(agentId),
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts,
		memo: '',
		actions
	}));
	assert(value.results?.length === actions.length, `unexpected action results: ${JSON.stringify(value)}`);
	return value.results;
}

async function submitOne(agentId, action, thoughts) {
	return (await submit(agentId, [action], thoughts))[0];
}

async function waitFor(label, predicate, timeoutMs = 240_000, intervalMs = 100) {
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
	throw new Error(`TIMEOUT ${label}; latest=${JSON.stringify(latest)?.slice(0, 1000)}`);
}

function queueFor(obs, item) {
	return obs.productionQueues.find(queue => queue.buildableItems.includes(item));
}

async function buildAndPlace(agentId, item) {
	const obs = await waitFor(`${item} is buildable`, async () => {
		const candidate = await observation(agentId);
		return queueFor(candidate, item) == null ? false : candidate;
	});
	let queue = queueFor(obs, item);
	let result = await submitOne(agentId, {
		type: 'startProduction', producerId: queue.producerId, item, count: 1, queued: false
	});
	assert(result.accepted, `${item} production rejected: ${result.reason}`);
	const ready = await waitFor(`${item} is placeable`, async () => {
		const candidate = await observation(agentId);
		const candidateQueue = queueFor(candidate, item);
		return candidateQueue?.items.some(entry => entry.item === item && entry.placeable)
			? { obs: candidate, queue: candidateQueue } : false;
	});
	queue = ready.queue;
	result = await submitOne(agentId, { type: 'placeBuildingAuto', producerId: queue.producerId, item });
	assert(result.accepted, `${item} placement rejected: ${result.reason}`);
	await waitFor(`${item} actor exists`, async () => {
		const candidate = await observation(agentId);
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === item);
	});
}

async function missionEvents(agentId) {
	const value = await call('GetAgentMissionEvents', agentId, 0);
	assert(value.events.length <= 128, `mission event history is unbounded: ${value.events.length}`);
	return value.events;
}

function doctrineScout(obs) {
	return obs.hostTruth.missions.find(mission => mission.missionId === 'doctrine-scout');
}

let opponentKeeperTick = -1000;
let progressLogTick = -1000;

async function keepOpponentUndeployed(opponentId, scoutObservation) {
	if (scoutObservation.worldTick - opponentKeeperTick < 100) return;
	const opponent = await observation(opponentId);
	const mcv = opponent.actors.find(actor => actor.relationship === 'self' && actor.type === 'mcv');
	if (mcv == null) return;
	const scouts = scoutObservation.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1');
	const corners = [
		{ x: opponent.mapMinX + 2, y: opponent.mapMinY + 2 },
		{ x: opponent.mapMaxX - 2, y: opponent.mapMinY + 2 },
		{ x: opponent.mapMinX + 2, y: opponent.mapMaxY - 2 },
		{ x: opponent.mapMaxX - 2, y: opponent.mapMaxY - 2 }
	];
	const target = corners.sort((a, b) => {
		const distance = cell => scouts.length === 0 ? 0 : Math.min(...scouts.map(actor =>
			(actor.cellX - cell.x) ** 2 + (actor.cellY - cell.y) ** 2));
		return distance(b) - distance(a) || a.y - b.y || a.x - b.x;
	})[0];
	if ((mcv.cellX - target.x) ** 2 + (mcv.cellY - target.y) ** 2 <= 16) return;
	const result = await submitOne(opponentId, {
		type: 'move', actorIds: [mcv.actorId], cellX: target.x, cellY: target.y, queued: false
	}, 'Keep the undeployed opponent fixture away from doctrine scouts.');
	assert(result.accepted, `opponent MCV keeper move rejected: ${result.reason}`);
	opponentKeeperTick = opponent.worldTick;
}

try {
	assert(await probe(serverUrl) == null, `port ${port} is already in use`);
	const startup = { listening: false, stderr: '' };
	server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(port)], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout.on('data', chunk => {
		if (String(chunk).includes('[server] serving ')) startup.listening = true;
	});
	server.stderr.on('data', chunk => { startup.stderr = `${startup.stderr}${chunk}`.slice(-2000); });
	await waitFor('owned bundle server', async () => startup.listening && await probe(serverUrl) === 200, 10_000);

	browser = await chromium.launch({ headless: !headed });
	page = await browser.newPage();
	page.on('pageerror', error => console.error('[pageerror]', String(error)));
	await page.goto(gameUrl);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } },
		undefined, { timeout: 60_000 });

	const started = await call('StartAgentMatch', '', JSON.stringify({
		schemaVersion: 1,
		fakeAgents: false,
		decisionIntervalTicks: 500,
		faction1: 'russia',
		faction2: 'russia',
		strategyArsenalEnabled: true,
		doctrineExecutorEnabled: true,
		actionGuidanceEnabled: true,
		doctrineFallbackStrikeEnabled: false
	}));
	const [agentId, opponentId] = started.agentIds;
	await waitFor('regular executor world', async () => {
		const current = await state();
		return current.state === 'running' && current.worldTick >= 25 ? current : false;
	});

	let obs = await observation(agentId);
	let mcv = obs.actors.find(actor => actor.relationship === 'self' && actor.capabilities.includes('deploy'));
	let result = await submitOne(agentId, { type: 'deploy', actorIds: [mcv.actorId] });
	assert(result.accepted, `MCV deploy rejected: ${result.reason}`);
	await waitFor('construction yard', async () => (await observation(agentId)).base.yards.length !== 0);
	await buildAndPlace(agentId, 'powr');
	await buildAndPlace(agentId, 'barr');

	obs = await observation(agentId);
	const infantryQueue = queueFor(obs, 'e1');
	const existingInfantry = new Set(obs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1')
		.map(actor => actor.actorId));
	result = await submitOne(agentId, {
		type: 'startProduction', producerId: infantryQueue.producerId, item: 'e1', count: 5, queued: false
	});
	assert(result.accepted, `scout production rejected: ${result.reason}`);
	obs = await waitFor('first five setup rifle scouts', async () => {
		const candidate = await observation(agentId);
		return candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1' &&
			!existingInfantry.has(actor.actorId)).length >= 5 ? candidate : false;
	});
	result = await submitOne(agentId, {
		type: 'startProduction', producerId: queueFor(obs, 'e1').producerId, item: 'e1', count: 3, queued: false
	});
	assert(result.accepted, `second scout production rejected: ${result.reason}`);
	obs = await waitFor('eight setup rifle scouts', async () => {
		const candidate = await observation(agentId);
		return candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1' &&
			!existingInfantry.has(actor.actorId)).length >= 8 ? candidate : false;
	});
	const setupScouts = obs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1' &&
		!existingInfantry.has(actor.actorId)).sort((a, b) => a.actorId - b.actorId).slice(0, 8);
	const laneYs = setupScouts.map((_, index) =>
		Math.round(obs.mapMinY + (obs.mapMaxY - obs.mapMinY) * ((index + 0.5) / setupScouts.length)));
	const firstLaneResults = await submit(agentId, setupScouts.map((actor, index) => ({
		type: 'move', actorIds: [actor.actorId], cellX: obs.mapMinX + 3,
		cellY: laneYs[index], queued: false
	})), 'Fan out the future doctrine scouts along parallel lanes to shorten the deterministic fixture setup.');
	const secondLaneResults = await submit(agentId, setupScouts.map((actor, index) => ({
		type: 'move', actorIds: [actor.actorId], cellX: obs.mapMaxX - 3,
		cellY: laneYs[index], queued: true
	})), 'Queue the second half of each deterministic setup lane.');
	const spreadResults = [...firstLaneResults, ...secondLaneResults];
	assert(spreadResults.every(item => item.accepted), `scout spread rejected: ${JSON.stringify(spreadResults)}`);
	await waitFor('fixture pre-explores the doctrine threshold in parallel', async () => {
		const candidate = await observation(agentId);
		await keepOpponentUndeployed(opponentId, candidate);
		if (candidate.worldTick - progressLogTick >= 500) {
			console.log(`SETUP tick=${candidate.worldTick} explored=${candidate.hostTruth.doctrine.progress.exploredPercent}`);
			progressLogTick = candidate.worldTick;
		}
		return candidate.hostTruth.doctrine.progress.exploredPercent >= 35 ? candidate : false;
	}, 420_000, 50);
	const doctrineSetupScouts = setupScouts.slice(0, 4);
	const auxiliaryScouts = setupScouts.slice(4);
	result = await submitOne(agentId, { type: 'stop', actorIds: doctrineSetupScouts.map(actor => actor.actorId) });
	assert(result.accepted, `pre-exploration stop rejected: ${result.reason}`);
	const columnXs = auxiliaryScouts.map((_, index) =>
		Math.round(obs.mapMinX + (obs.mapMaxX - obs.mapMinX) * ((index + 0.5) / auxiliaryScouts.length)));
	const columnResults = await submit(agentId, auxiliaryScouts.flatMap((actor, index) => [
		{ type: 'move', actorIds: [actor.actorId], cellX: columnXs[index],
			cellY: obs.mapMinY + 3, queued: false },
		{ type: 'move', actorIds: [actor.actorId], cellX: columnXs[index],
			cellY: obs.mapMaxY - 3, queued: true }
	]), 'Finish fixture exploration with non-doctrine auxiliary scouts.');
	assert(columnResults.every(item => item.accepted),
		`auxiliary scout columns rejected: ${JSON.stringify(columnResults)}`);

	result = await submitOne(agentId, {
		type: 'adoptStrategy', strategyId: 'soviet-tank-pressure', reason: 'Exercise contact-required doctrine scouting.'
	});
	assert(result.accepted, `strategy adoption rejected: ${result.reason}`);

	obs = await waitFor('doctrine scout reaches contact-seeking beyond the phase threshold', async () => {
		const candidate = await observation(agentId);
		await keepOpponentUndeployed(opponentId, candidate);
		const scout = doctrineScout(candidate);
		if (candidate.worldTick - progressLogTick >= 500) {
			console.log(`SCOUT tick=${candidate.worldTick} explored=${candidate.hostTruth.doctrine.progress.exploredPercent} ` +
				`known=${candidate.hostTruth.knownEnemyStructureCount} mission=${scout?.missionVersion ?? '-'}:${scout?.state ?? '-'}`);
			progressLogTick = candidate.worldTick;
		}
		return scout?.state === 'contact-seeking' && scout.missionVersion === 1 &&
			candidate.hostTruth.doctrine.progress.exploredPercent >= 35 &&
			candidate.hostTruth.knownEnemyStructureCount === 0 ? candidate : false;
	}, 240_000, 50);
	const scoutIds = obs.groups.find(group => group.name === 'scouts')?.actorIds ?? [];
	assert(scoutIds.length >= 1, 'doctrine scout group is empty');
	const positions = new Map(obs.actors.filter(actor => scoutIds.includes(actor.actorId))
		.map(actor => [actor.actorId, `${actor.cellX},${actor.cellY}`]));
	const thresholdTick = obs.worldTick;
	obs = await waitFor('same doctrine mission keeps moving after threshold', async () => {
		const candidate = await observation(agentId);
		await keepOpponentUndeployed(opponentId, candidate);
		const moved = candidate.actors.some(actor => positions.has(actor.actorId) &&
			positions.get(actor.actorId) !== `${actor.cellX},${actor.cellY}`);
		return candidate.worldTick >= thresholdTick + 100 && doctrineScout(candidate)?.missionVersion === 1 && moved
			? candidate : false;
	}, 60_000, 50);
	let events = await missionEvents(agentId);
	const firstCycle = events.filter(event => event.missionId === 'doctrine-scout' && event.missionVersion === 1);
	assert(firstCycle.filter(event => event.state === 'planned').length === 1,
		`doctrine scout v1 planned more than once: ${JSON.stringify(firstCycle)}`);
	assert(!firstCycle.some(event => event.state === 'completed'),
		`contactless doctrine scout completed at its exploration threshold: ${JSON.stringify(firstCycle)}`);

	result = await submitOne(agentId, { type: 'stop', actorIds: scoutIds });
	assert(result.accepted, `model scout override rejected: ${result.reason}`);
	await waitFor('model override releases doctrine scout v1', async () => doctrineScout(await observation(agentId)) == null,
		30_000, 25);
	obs = await waitFor('one doctrine scout relaunch after full cooldown', async () => {
		const candidate = await observation(agentId);
		await keepOpponentUndeployed(opponentId, candidate);
		return doctrineScout(candidate)?.missionVersion === 2 ? candidate : false;
	}, 180_000, 25);
	events = await missionEvents(agentId);
	const terminalV1 = events.filter(event => event.missionId === 'doctrine-scout' && event.missionVersion === 1 &&
		(event.state === 'aborted' || event.state === 'completed')).at(-1);
	const plannedV2 = events.find(event => event.missionId === 'doctrine-scout' && event.missionVersion === 2 &&
		event.state === 'planned');
	assert(terminalV1 != null && plannedV2 != null && plannedV2.worldTick - terminalV1.worldTick >= 750,
		`scout relaunched before 750 ticks: terminal=${JSON.stringify(terminalV1)} planned=${JSON.stringify(plannedV2)}`);
	assert(events.filter(event => event.missionId === 'doctrine-scout' && event.missionVersion === 2 &&
		event.state === 'planned').length === 1, 'doctrine scout relaunched more than once');

	await waitFor('raw sweep threshold is already reached', async () => {
		const candidate = await observation(agentId);
		await keepOpponentUndeployed(opponentId, candidate);
		return candidate.hostTruth.doctrine.progress.exploredPercent >= 50 ? candidate : false;
	}, 120_000, 50);
	result = await submitOne(agentId, { type: 'controlDoctrine', doctrineCommand: 'pause' });
	assert(result.accepted, `doctrine pause rejected: ${result.reason}`);
	result = await submitOne(agentId, {
		type: 'controlMission', missionId: 'doctrine-scout', missionVersion: 2, missionCommand: 'cancel'
	});
	assert(result.accepted, `doctrine scout v2 cancel rejected: ${result.reason}`);
	await waitFor('doctrine scout v2 releases', async () => doctrineScout(await observation(agentId)) == null, 30_000, 25);
	obs = await observation(agentId);
	const liveActorIds = new Set(obs.actors.filter(actor => actor.relationship === 'self').map(actor => actor.actorId));
	const rawIds = (obs.groups.find(group => group.name === 'scouts')?.actorIds ?? scoutIds)
		.filter(actorId => liveActorIds.has(actorId));
	assert(rawIds.length !== 0, 'no live doctrine scout remains for the direct sweep check');
	result = await submitOne(agentId, { type: 'assignGroup', name: 'raw-scouts', actorIds: rawIds });
	assert(result.accepted, `raw scout group rejected: ${result.reason}`);
	result = await submitOne(agentId, {
		type: 'queueMission', missionId: 'raw-sweep', missionType: 'sweep', missionVersion: 1,
		groupName: 'raw-scouts', exploredPercentTarget: 50, abortLossPercent: 50
	});
	assert(result.accepted, `raw sweep rejected: ${result.reason}`);
	await waitFor('ordinary raw sweep completes at its percentage threshold', async () => {
		const rawEvents = await missionEvents(agentId);
		return rawEvents.some(event => event.missionId === 'raw-sweep' && event.state === 'completed' &&
			/^explored \d+% of the map$/.test(event.reason ?? '')) ? rawEvents : false;
	}, 30_000, 25);

	const opponent = await observation(opponentId);
	assert(opponent.actors.some(actor => actor.relationship === 'self' && actor.type === 'mcv'),
		'opponent MCV did not remain undeployed');
	assert(!opponent.actors.some(actor => actor.relationship === 'self' && ['fact', 'afac'].includes(actor.type)),
		'opponent unexpectedly deployed a construction yard');
	console.log('SAFE ACL CONTINUITY GATE: PASS');
} catch (error) {
	console.error('SAFE ACL CONTINUITY GATE FAILED:', error.message);
	process.exitCode = 1;
} finally {
	try { await page?.evaluate(() => globalThis.ora?.StopAgentMatch()); } catch { /* preserve primary result */ }
	await browser?.close();
	await stopChild(server);
}
