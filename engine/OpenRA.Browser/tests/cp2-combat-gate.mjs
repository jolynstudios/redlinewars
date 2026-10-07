// Era 3 CP2 browser gate: situation recognition, automatic repair, air sorties,
// and support-power activation through synchronized typed orders only.
//
// This is deliberately separate from skills-gate.mjs. These combat fixtures
// need fresh actors, independent waves, and a stable air target; coupling them
// to the long CP1/CP2 mission-contract gate made their preconditions dependent
// on earlier pathing and damage.
// Usage: node cp2-combat-gate.mjs [--headed]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const unknownArgs = args.filter(arg => arg !== '--headed');
if (unknownArgs.length !== 0) {
	console.error(`Unknown argument(s): ${unknownArgs.join(', ')}`);
	console.error('Usage: node cp2-combat-gate.mjs [--headed]');
	process.exit(2);
}

const port = 8363;
const serverUrl = `http://127.0.0.1:${port}/`;
const url = `${serverUrl}index.html?mode=game&platform=webgl2&Host.DevContent=1&Host.AgentMode=1&` +
	'Launch.Map=Siberian-Pass.oramap&Debug.ServerRandomSeed=56789';
const MaxObservationBytes = 256 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let browser;
let page;
let cleanupPromise;
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

async function waitFor(label, predicate, timeoutMs = 180_000, intervalMs = 50) {
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

async function observation(id) {
	const result = await raw('GetAgentObservation', id, 0);
	if (result.value?.error) {
		throw new Error(`GetAgentObservation: ${result.value.error}`);
	}

	const bytes = Buffer.byteLength(result.text, 'utf8');
	assert(bytes < MaxObservationBytes, `observation is ${bytes} bytes (limit ${MaxObservationBytes})`);
	assert(Array.isArray(result.value.situations) && result.value.situations.length <= 5,
		`situation state is missing or unbounded: ${JSON.stringify(result.value.situations)}`);
	assert(new Set(result.value.situations.map(situation => situation.key)).size === result.value.situations.length,
		`situation keys are not unique: ${JSON.stringify(result.value.situations)}`);
	await state();
	return result.value;
}

function nextDecisionId(id) {
	const next = (decisionIds.get(id) ?? 0) + 1;
	decisionIds.set(id, next);
	return next;
}

async function submit(id, actions, thoughts = 'CP2 synchronized combat-gate action.') {
	const obs = await observation(id);
	return submitObserved(id, obs, actions, thoughts);
}

async function submitObserved(id, obs, actions, thoughts = 'CP2 synchronized combat-gate action.') {
	const batch = {
		schemaVersion: 1,
		decisionId: nextDecisionId(id),
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts,
		memo: '',
		actions
	};
	const value = await call('SubmitAgentActions', id, JSON.stringify(batch));
	assert(Array.isArray(value.results) && value.results.length === actions.length,
		`unexpected action results: ${JSON.stringify(value)}`);
	return value;
}

async function submitOne(id, action, thoughts) {
	return (await submit(id, [action], thoughts)).results[0];
}

async function missionEvents(id, sinceSequence = 0) {
	const value = await call('GetAgentMissionEvents', id, sinceSequence);
	assert(Number.isInteger(value.latestSequence) && Array.isArray(value.events),
		`mission-event contract is invalid: ${JSON.stringify(value)}`);
	return value;
}

async function reflexEvents(id, sinceSequence = 0) {
	const value = await call('GetAgentReflexEvents', id, sinceSequence);
	assert(Number.isInteger(value.latestSequence) && Array.isArray(value.events),
		`reflex-event contract is invalid: ${JSON.stringify(value)}`);
	return value;
}

function findQueue(obs, item) {
	return obs.productionQueues.find(queue => queue.buildableItems.includes(item));
}

async function waitTicks(id, ticks, label) {
	const start = await observation(id);
	return waitFor(label, async () => {
		const candidate = await observation(id);
		return candidate.worldTick >= start.worldTick + ticks ? candidate : false;
	}, 60_000, 20);
}

async function waitForReadyBuilding(id, item) {
	return waitFor(`${item} becomes placeable`, async () => {
		const obs = await observation(id);
		const queue = findQueue(obs, item);
		return queue?.items.some(entry => entry.item === item && entry.placeable) ? { obs, queue } : false;
	}, 240_000, 100);
}

async function buildAndPlace(id, item) {
	const obs = await waitFor(`${item} becomes buildable`, async () => {
		const candidate = await observation(id);
		return findQueue(candidate, item) != null ? candidate : false;
	}, 240_000, 100);
	const queue = findQueue(obs, item);
	const beforeIds = new Set(obs.actors.filter(actor => actor.relationship === 'self' && actor.type === item)
		.map(actor => actor.actorId));
	let result = await submitOne(id, {
		type: 'startProduction', producerId: queue.producerId, item, count: 1, queued: false
	});
	assert(result.accepted, `startProduction ${item} rejected: ${result.reason}`);
	const ready = await waitForReadyBuilding(id, item);
	result = await submitOne(id, { type: 'placeBuildingAuto', producerId: ready.queue.producerId, item });
	assert(result.accepted, `placeBuildingAuto ${item} rejected: ${result.reason}`);
	return waitFor(`fresh ${item} actor appears`, async () => {
		const candidate = await observation(id);
		const actor = candidate.actors.find(entry => entry.relationship === 'self' && entry.type === item &&
			!beforeIds.has(entry.actorId));
		return actor == null ? false : { obs: candidate, actor };
	}, 180_000, 100);
}

async function produceUnits(id, item, count, label) {
	const before = await waitFor(`${label} queue`, async () => {
		const candidate = await observation(id);
		return findQueue(candidate, item) != null ? candidate : false;
	}, 180_000, 100);
	const queue = findQueue(before, item);
	const beforeIds = new Set(before.actors.filter(actor => actor.relationship === 'self' && actor.type === item)
		.map(actor => actor.actorId));
	for (let remaining = count; remaining > 0; remaining -= 5) {
		const batchCount = Math.min(5, remaining);
		const result = await submitOne(id, {
			type: 'startProduction', producerId: queue.producerId, item, count: batchCount, queued: false
		});
		assert(result.accepted, `${label} production rejected: ${result.reason}`);
	}
	return waitFor(label, async () => {
		const candidate = await observation(id);
		const actors = candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === item &&
			!beforeIds.has(actor.actorId)).sort((a, b) => a.actorId - b.actorId);
		return actors.length >= count ? { obs: candidate, actors: actors.slice(0, count) } : false;
	}, 300_000, 100);
}

async function bootstrap(id, infantryCount, barracksItem = 'barr') {
	let obs = await observation(id);
	const mcv = obs.actors.find(actor => actor.relationship === 'self' && actor.capabilities.includes('deploy'));
	assert(mcv != null, `agent ${id} has no deployable MCV`);
	let result = await submitOne(id, { type: 'deploy', actorIds: [mcv.actorId] });
	assert(result.accepted, `agent ${id} MCV deploy rejected: ${result.reason}`);
	await waitFor(`agent ${id} Construction Yard appears`, async () => {
		const candidate = await observation(id);
		return candidate.base.yards.length !== 0 ? candidate : false;
	}, 120_000, 50);
	await buildAndPlace(id, 'powr');
	await buildAndPlace(id, barracksItem);
	if (infantryCount === 0) {
		return { obs: await observation(id), actors: [] };
	}

	return produceUnits(id, 'e1', infantryCount, `agent ${id} produces ${infantryCount} infantry`);
}

function clampCell(obs, cell) {
	return {
		x: Math.max(obs.mapMinX, Math.min(obs.mapMaxX, cell.x)),
		y: Math.max(obs.mapMinY, Math.min(obs.mapMaxY, cell.y))
	};
}

function shiftedCell(obs, origin, dx, dy) {
	const cell = clampCell(obs, { x: origin.x + dx, y: origin.y + dy });
	return { x: cell.x === 0 ? 1 : cell.x, y: cell.y === 0 ? 1 : cell.y };
}

function vectorStep(from, toward, cells) {
	const dx = toward.x - from.x;
	const dy = toward.y - from.y;
	const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
	return { x: Math.round(from.x + dx / length * cells), y: Math.round(from.y + dy / length * cells) };
}

function actorCentroid(actors) {
	return {
		x: Math.floor(actors.reduce((sum, actor) => sum + actor.cellX, 0) / actors.length),
		y: Math.floor(actors.reduce((sum, actor) => sum + actor.cellY, 0) / actors.length)
	};
}

async function moveAndWait(id, actorIds, cell, label, radiusSquared = 16) {
	const result = await submitOne(id, {
		type: 'move', actorIds, cellX: cell.x, cellY: cell.y, queued: false
	});
	assert(result.accepted, `${label} move rejected: ${result.reason}`);
	return waitFor(label, async () => {
		const candidate = await observation(id);
		const actors = actorIds.map(actorId => candidate.actors.find(actor => actor.actorId === actorId)).filter(Boolean);
		return actors.length === actorIds.length && actors.every(actor =>
			(actor.cellX - cell.x) ** 2 + (actor.cellY - cell.y) ** 2 <= radiusSquared) ? candidate : false;
	}, 120_000, 50);
}

async function stopActors(id, actorIds, label) {
	if (actorIds.length === 0) {
		return;
	}

	const result = await submitOne(id, { type: 'stop', actorIds });
	assert(result.accepted, `${label} stop rejected: ${result.reason}`);
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

	const started = await call('StartAgentMatch', '', JSON.stringify({
		schemaVersion: 1,
		fakeAgents: false,
		decisionIntervalTicks: 500,
		faction1: 'russia',
		faction2: 'russia'
	}));
	assert(started.era === 'era3-skills' && started.agentIds.length === 2,
		`unexpected CP2 match start: ${JSON.stringify(started)}`);
	const [agentId, otherAgentId] = started.agentIds;
	await waitFor('regular CP2 world', async () => {
		const current = await state();
		return current.state === 'running' && current.worldTick >= 25 ? current : false;
	});

	// Disable combat reflexes while the situation fixtures establish exact
	// synchronized preconditions. Automatic repair is enabled only for its own
	// phase below.
	for (const id of [agentId, otherAgentId]) {
		const policy = await submitOne(id, {
			type: 'setPolicy',
			autoReturnFire: false,
			harvesterFlee: false,
			rallyNewUnitsToDefense: false,
			defendCriticalAssets: false,
			retreatBelowHpPercent: 0,
			autoRepairBuildings: false
		});
		assert(policy.accepted, `agent ${id} neutral fixture policy rejected: ${policy.reason}`);
	}

	let own = await bootstrap(agentId, 0);
	const enemy = await bootstrap(otherAgentId, 10);
	let ownObs = await observation(agentId);
	let enemyObs = await observation(otherAgentId);
	const ownYard = ownObs.base.yards[0];
	const enemyYard = enemyObs.base.yards[0];
	assert(ownYard != null && enemyYard != null, 'both synchronized bases are required');
	let result;

	// Build four unarmed observers. One establishes a bounded first-contact
	// sight disk; the other three initially wait far off the withdrawal lane so
	// they cannot move the detector's contact anchor outward before contact.
	await buildAndPlace(agentId, 'proc');
	const firstObserver = await waitFor('first fixture harvester appears', async () => {
		const candidate = await observation(agentId);
		return candidate.actors.find(actor => actor.relationship === 'self' && actor.type === 'harv') ?? false;
	}, 180_000, 100);
	await buildAndPlace(agentId, 'powr');
	const firstHarvesterIds = new Set((await observation(agentId)).actors
		.filter(actor => actor.relationship === 'self' && actor.type === 'harv').map(actor => actor.actorId));
	await buildAndPlace(agentId, 'proc');
	const secondObserver = await waitFor('second fixture harvester appears', async () => {
		const candidate = await observation(agentId);
		return candidate.actors.find(actor => actor.relationship === 'self' && actor.type === 'harv' &&
			!firstHarvesterIds.has(actor.actorId)) ?? false;
	}, 180_000, 100);
	const firstTwoHarvesterIds = new Set((await observation(agentId)).actors
		.filter(actor => actor.relationship === 'self' && actor.type === 'harv').map(actor => actor.actorId));
	await buildAndPlace(agentId, 'proc');
	const thirdObserver = await waitFor('third fixture harvester appears', async () => {
		const candidate = await observation(agentId);
		return candidate.actors.find(actor => actor.relationship === 'self' && actor.type === 'harv' &&
			!firstTwoHarvesterIds.has(actor.actorId)) ?? false;
	}, 180_000, 100);
	const firstThreeHarvesterIds = new Set((await observation(agentId)).actors
		.filter(actor => actor.relationship === 'self' && actor.type === 'harv').map(actor => actor.actorId));
	await buildAndPlace(agentId, 'proc');
	const fourthObserver = await waitFor('fourth fixture harvester appears', async () => {
		const candidate = await observation(agentId);
		return candidate.actors.find(actor => actor.relationship === 'self' && actor.type === 'harv' &&
			!firstThreeHarvesterIds.has(actor.actorId)) ?? false;
	}, 180_000, 100);
	const lineX = Math.sign(enemyYard.x - ownYard.x);
	const lineY = Math.sign(enemyYard.y - ownYard.y);
	await stopActors(agentId, [firstObserver.actorId], 'contact observer');
	const holdingCells = [-10, 10, 16].map(offset => clampCell(ownObs, {
		x: firstObserver.cellX - lineY * offset,
		y: firstObserver.cellY + lineX * offset
	}));
	for (const [index, observer] of [secondObserver, thirdObserver, fourthObserver].entries()) {
		await moveAndWait(agentId, [observer.actorId], holdingCells[index],
			`corridor observer ${index + 1} prestages outside the contact lane`, 25);
		await stopActors(agentId, [observer.actorId], `corridor observer ${index + 1} prestage`);
	}

	// Enemy-retreating: three synchronized Yaks form a material force, make
	// contact, then continuously withdraw. Ground formations cannot honestly
	// cover the detector's six-cell/three-sample threshold on this obstructed map;
	// Yaks have rules-derived speed margin, fly obstacle-free, and default to
	// HoldFire. No omniscient observation or mutation hook is involved.
	await buildAndPlace(otherAgentId, 'proc');
	const reserveSpotter = await waitFor('reserve-side fixture harvester appears', async () => {
		const candidate = await observation(otherAgentId);
		return candidate.actors.find(actor => actor.relationship === 'self' && actor.type === 'harv') ?? false;
	}, 180_000, 100);
	await buildAndPlace(otherAgentId, 'powr');
	await buildAndPlace(otherAgentId, 'dome');
	await buildAndPlace(otherAgentId, 'afld');
	const retreatFixture = await produceUnits(otherAgentId, 'yak', 5,
		`agent ${otherAgentId} produces the retreat Yaks`);
	assert(retreatFixture.actors.every(actor => actor.capabilities.includes('move')),
		`fresh aircraft do not advertise typed move: ${JSON.stringify(retreatFixture.actors)}`);
	console.log('OK fresh aircraft advertise the typed move capability');
	const retreatWave = retreatFixture.actors;
	const retreatIds = retreatWave.map(actor => actor.actorId);
	const contactOrigin = { x: firstObserver.cellX, y: firstObserver.cellY };
	const approachCell = vectorStep(contactOrigin, enemyYard, 4);
	await moveAndWait(otherAgentId, retreatIds, approachCell, 'material enemy force approaches first base', 25);
	const contact = await waitFor('first agent sees the approaching material force', async () => {
		const candidate = await observation(agentId);
		const visible = candidate.actors.filter(actor => actor.relationship === 'enemy' && retreatIds.includes(actor.actorId));
		const alert = candidate.alerts.find(item => item.kind === 'firstContact');
		return visible.length >= 3 && alert != null ? { obs: candidate, alert } : false;
	}, 120_000, 20);
	const anchor = contact.alert.cell;
	assert(anchor != null, `first-contact alert has no fog-safe cell: ${JSON.stringify(contact.alert)}`);
	await stopActors(otherAgentId, retreatIds, 'material force at its near-base contact anchor');
	// Only after the fog-safe alert fixes the episode anchor do the corridor
	// observers move inward. Their offset sight disks overlap from the anchor to
	// twenty-six cells downrange while keeping the flight path unobstructed.
	const corridorCells = [4, 10, 16].map(distance => {
		return vectorStep(anchor, enemyYard, distance);
	});
	for (const [index, observer] of [secondObserver, thirdObserver, fourthObserver].entries()) {
		await moveAndWait(agentId, [observer.actorId], corridorCells[index],
			`corridor observer ${index + 1} completes the post-contact lane`, 25);
		await stopActors(agentId, [observer.actorId], `corridor observer ${index + 1} lane post`);
	}
	const farAlong = vectorStep(anchor, enemyYard, 22);
	const farObserverCell = clampCell(contact.obs, farAlong);
	await moveAndWait(agentId, [firstObserver.actorId], farObserverCell,
		'contact observer completes the far post-contact lane', 25);
	await stopActors(agentId, [firstObserver.actorId], 'far corridor observer lane post');
	const settledRetreatObs = await waitTicks(agentId, 75,
		'retreat detector samples the stopped force through the completed corridor');
	const settledVisible = settledRetreatObs.actors.filter(actor => actor.relationship === 'enemy' &&
		retreatIds.includes(actor.actorId));
	assert(settledVisible.length >= 3,
		`completed corridor lost the material force before withdrawal: ${JSON.stringify(settledVisible)}`);
	assert(!settledRetreatObs.alerts.some(alert => alert.kind === 'enemyRetreating'),
		'enemyRetreating fired before the synchronized withdrawal began');
	const withdrawalTarget = clampCell(contact.obs, { x: enemyYard.x, y: enemyYard.y });
	result = await submitOne(otherAgentId, {
		type: 'move', actorIds: retreatIds, cellX: withdrawalTarget.x, cellY: withdrawalTarget.y, queued: false
	});
	assert(result.accepted, `retreat wave move rejected: ${result.reason}`);
	let retreatTraceTick = -1;
	const retreatAlert = await waitFor('enemyRetreating situation alert appears', async () => {
		const candidate = await observation(agentId);
		if (candidate.worldTick - retreatTraceTick >= 25) {
			retreatTraceTick = candidate.worldTick;
			const visible = candidate.actors.filter(actor => actor.relationship === 'enemy' &&
				retreatIds.includes(actor.actorId));
			console.log(`TRACE retreat tick=${candidate.worldTick} visible=${visible.length} ` +
				visible.map(actor => `${actor.actorId}@${actor.cellX},${actor.cellY}`).join(';'));
		}
		return candidate.alerts.find(alert => alert.kind === 'enemyRetreating' &&
			alert.firstSeenTick >= settledRetreatObs.worldTick) ?? false;
	}, 60_000, 20);
	assert(retreatAlert.threat?.visibleEnemyCount >= 2 && retreatAlert.visibleAttackerSummary?.length > 0,
		`enemyRetreating alert lacks a visible threat estimate: ${JSON.stringify(retreatAlert)}`);
	const retreatSituation = (await observation(agentId)).situations.find(situation =>
		situation.id === 'O1.retreat' && situation.fromAlerts.includes('enemyRetreating'));
	assert(retreatSituation != null && retreatSituation.sinceTick >= settledRetreatObs.worldTick,
		`retreat alert did not enter persistent situation state: ${JSON.stringify(retreatSituation)}`);
	await stopActors(otherAgentId, retreatIds, 'retreat wave after situation edge');
	console.log('OK enemyRetreating derives from three fog-safe synchronized samples');

	// Reinforcement-needed: record a named five-unit high-water squad, bring the
	// fresh enemy reserve into view, and kill exactly two named members using
	// direct synchronized attacks. Stopping between casualties prevents a fast
	// Release build from turning the threshold fixture into a wipeout.
	own = await produceUnits(agentId, 'e1', 5, `agent ${agentId} produces the attrition squad`);
	result = await submitOne(agentId, {
		type: 'assignGroup', name: 'cp2-attrition', actorIds: own.actors.map(actor => actor.actorId)
	});
	assert(result.accepted, `attrition squad assignment rejected: ${result.reason}`);
	await waitTicks(agentId, 30, 'attrition squad high-water count is sampled');
	const reserve = enemy.actors.slice(5);
	const reserveIds = reserve.map(actor => actor.actorId);
	ownObs = await observation(agentId);
	const victims = own.actors.slice(0, 2);
	const protectedActors = own.actors.slice(2);
	// Anchor casualty 1 at its existing synchronized cell. Moving it to a
	// synthetic offset made the fixture depend on whether that map cell happened
	// to be reachable around Release-timed building footprints.
	const firstVictimAtAnchor = ownObs.actors.find(actor => actor.actorId === victims[0].actorId);
	assert(firstVictimAtAnchor != null, 'first attrition target disappeared before fixture placement');
	const sacrificeCell = { x: firstVictimAtAnchor.cellX, y: firstVictimAtAnchor.cellY };
	const survivorPark = shiftedCell(ownObs, sacrificeCell, -9, 0);
	const spotterPost = shiftedCell(ownObs, sacrificeCell, 0, -3);
	await moveAndWait(agentId, protectedActors.map(actor => actor.actorId), survivorPark,
		'three non-target attrition members reach their protected park', 4);
	const reserveHolding = shiftedCell(ownObs, sacrificeCell, 8, 0);
	await moveAndWait(otherAgentId, reserveIds, reserveHolding,
		'enemy reserve reaches the isolated attrition holding area', 1);
	// HARV has rules-derived sight 4 and no armament. Move it to the proven
	// reachable side of the sacrifice lane, then derive victim 2 from its actual
	// synchronized cell instead of assuming that a fixed map cell is pathable.
	// The E1 reserve stays at least seven cells away (beyond its M1Carbine range
	// 5) until this spotter supplies the exact target-visible observation.
	await moveAndWait(otherAgentId, [reserveSpotter.actorId], spotterPost,
		'unarmed reserve spotter reaches the isolated attrition post', 1);
	await stopActors(otherAgentId, [reserveSpotter.actorId], 'unarmed attrition spotter');
	const postedSpotterObservation = await observation(otherAgentId);
	const postedSpotter = postedSpotterObservation.actors.find(actor => actor.relationship === 'self' &&
		actor.actorId === reserveSpotter.actorId);
	assert(postedSpotter != null, 'unarmed attrition spotter disappeared after posting');
	const victimWaitingCell = shiftedCell(ownObs,
		{ x: postedSpotter.cellX, y: postedSpotter.cellY }, 0, -4);
	await moveAndWait(agentId, [victims[1].actorId], victimWaitingCell,
		'second attrition target reaches the spotter-derived waiting cell', 0);
	for (const [victimIndex, victim] of victims.entries()) {
		if (victimIndex === 0) {
			const anchored = await observation(agentId);
			const actor = anchored.actors.find(entry => entry.actorId === victim.actorId);
			assert(actor != null && actor.cellX === sacrificeCell.x && actor.cellY === sacrificeCell.y,
				`attrition target ${victim.actorId} left its synchronized loss cell: ${JSON.stringify(actor)}`);
			console.log(`OK attrition target ${victim.actorId} holds its synchronized loss cell`);
		}
		const visibleVictim = await waitFor(`unarmed spotter sees attrition target ${victim.actorId}`, async () => {
			const candidate = await observation(otherAgentId);
			const actor = candidate.actors.find(entry => entry.relationship === 'enemy' &&
				entry.actorId === victim.actorId);
			return actor == null ? false : { obs: candidate, actor };
		}, 60_000, 20);
		const liveBeforeAttack = visibleVictim.obs.actors
			.filter(actor => reserveIds.includes(actor.actorId)).map(actor => actor.actorId);
		assert(liveBeforeAttack.length > 0, 'armed reserve disappeared before attrition attack submission');
		if (victimIndex === 0) {
			const ownSafety = await observation(agentId);
			const waitingVictim = ownSafety.actors.find(entry => entry.actorId === victims[1].actorId);
			assert(waitingVictim != null &&
				(waitingVictim.cellX - sacrificeCell.x) ** 2 +
				(waitingVictim.cellY - sacrificeCell.y) ** 2 > 25,
				`second victim entered casualty-1 weapon range: ${JSON.stringify(waitingVictim)}`);
			const protectedIds = protectedActors.map(actor => actor.actorId);
			assert(protectedIds.every(actorId => {
				const actor = ownSafety.actors.find(entry => entry.actorId === actorId);
				return actor != null &&
					(actor.cellX - sacrificeCell.x) ** 2 + (actor.cellY - sacrificeCell.y) ** 2 > 25 &&
					(actor.cellX - victimWaitingCell.x) ** 2 + (actor.cellY - victimWaitingCell.y) ** 2 > 25;
			}), `protected attrition actors entered either victim's weapon lane: ${JSON.stringify(protectedIds)}`);
			assert(visibleVictim.obs.actors.some(entry => entry.relationship === 'enemy' &&
				entry.actorId === victims[1].actorId),
				'unarmed spotter does not simultaneously hold both attrition targets');
		}
		assert(liveBeforeAttack.every(actorId => {
			const actor = visibleVictim.obs.actors.find(entry => entry.actorId === actorId);
			return (actor.cellX - visibleVictim.actor.cellX) ** 2 +
				(actor.cellY - visibleVictim.actor.cellY) ** 2 > 25;
		}), `armed reserve entered its five-cell weapon range before attack submission: ${JSON.stringify(liveBeforeAttack)}`);
		result = (await submitObserved(otherAgentId, visibleVictim.obs, [{
			type: 'attack', actorIds: liveBeforeAttack,
			targetActorId: visibleVictim.actor.actorId, queued: false
		}])).results[0];
		assert(result.accepted, `attrition attack on ${victim.actorId} rejected: ${result.reason}`);
		await waitFor(`attrition target ${victim.actorId} is destroyed`, async () => {
			const candidate = await observation(agentId);
			return candidate.actors.some(actor => actor.actorId === victim.actorId) ? false : candidate;
		}, 120_000, 20);
	}
	const attritionBeforeAlert = await observation(agentId);
	const exactSurvivors = own.actors.map(actor => attritionBeforeAlert.actors
		.find(entry => entry.actorId === actor.actorId)).filter(Boolean);
	assert(exactSurvivors.length === 3,
		`attrition fixture did not preserve exactly 3-of-5 actors: ${JSON.stringify(exactSurvivors)}`);
	const survivorCenter = actorCentroid(exactSurvivors);
	const pressureCell = shiftedCell(attritionBeforeAlert, survivorCenter, 3, 0);
	const pressureIds = (await observation(otherAgentId)).actors
		.filter(actor => reserveIds.includes(actor.actorId)).map(actor => actor.actorId);
	result = await submitOne(otherAgentId, {
		type: 'move', actorIds: pressureIds, cellX: pressureCell.x, cellY: pressureCell.y, queued: false
	});
	assert(result.accepted, `reinforcement-pressure move rejected: ${result.reason}`);
	const reinforcementAlert = await waitFor('reinforcementNeeded appears at the 3-of-5 threshold', async () => {
		const candidate = await observation(agentId);
		return candidate.alerts.find(alert => alert.kind === 'reinforcementNeeded' &&
			alert.detail === "squad 'cp2-attrition' needs reinforcement") ?? false;
	}, 60_000, 20);
	assert(reinforcementAlert.threat?.visibleEnemyCount > 0,
		`reinforcement alert was not grounded in visible nearby enemies: ${JSON.stringify(reinforcementAlert)}`);
	const reinforcementSituation = (await observation(agentId)).situations.find(situation =>
		situation.id === 'T2.reinforcement' && situation.fromAlerts.includes('reinforcementNeeded'));
	assert(reinforcementSituation != null && reinforcementSituation.severity === 'critical',
		`reinforcement alert did not enter persistent situation state: ${JSON.stringify(reinforcementSituation)}`);
	const withdrawingPressureIds = (await observation(otherAgentId)).actors
		.filter(actor => reserveIds.includes(actor.actorId)).map(actor => actor.actorId);
	result = await submitOne(otherAgentId, {
		type: 'move', actorIds: withdrawingPressureIds,
		cellX: reserveHolding.x, cellY: reserveHolding.y, queued: false
	});
	assert(result.accepted, `reinforcement-pressure withdrawal rejected: ${result.reason}`);
	await waitFor('remaining reinforcement-pressure reserve withdraws', async () => {
		const candidate = await observation(otherAgentId);
		const remaining = candidate.actors.filter(actor => reserveIds.includes(actor.actorId));
		return remaining.length > 0 && remaining.every(actor =>
			(actor.cellX - reserveHolding.x) ** 2 + (actor.cellY - reserveHolding.y) ** 2 <= 4) ? candidate : false;
	}, 120_000, 50);
	console.log('OK reinforcementNeeded derives from a named squad losing two members under visible pressure');
	const attritionAfter = await observation(agentId);
	const survivingSquad = own.actors.map(actor => attritionAfter.actors.find(entry => entry.actorId === actor.actorId))
		.filter(Boolean);
	assert(survivingSquad.length === 3,
		`attrition fixture did not stop at exactly 3-of-5 survivors: ${JSON.stringify(survivingSquad)}`);
	const squadPark = shiftedCell(attritionAfter, actorCentroid(survivingSquad), -10, 10);
	await moveAndWait(agentId, survivingSquad.map(actor => actor.actorId), squadPark,
		'attrition survivors leave the automatic-repair fixture', 36);

	// Automatic repair: opt in, damage a fresh power plant through a normal
	// enemy attack, and require the actual reflex event for that building.
	const freshPower = await buildAndPlace(agentId, 'powr');
	const powerActor = freshPower.actor;
	const powerBefore = powerActor.health;
	assert(freshPower.obs.hostTruth.economy.cash >= 500,
		`automatic-repair fixture has insufficient cash: ${freshPower.obs.hostTruth.economy.cash}`);
	result = await submitOne(agentId, {
		type: 'setPolicy',
		autoReturnFire: false,
		harvesterFlee: false,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: false,
		retreatBelowHpPercent: 0,
		autoRepairBuildings: true
	});
	assert(result.accepted, `auto-repair policy rejected: ${result.reason}`);
	const repairCursor = (await reflexEvents(agentId)).latestSequence;
	let liveReserve = (await observation(otherAgentId)).actors
		.filter(actor => reserveIds.includes(actor.actorId)).sort((a, b) => a.actorId - b.actorId);
	assert(liveReserve.length > 0, 'no enemy infantry survived for the repair fixture');
	const repairApproach = clampCell(freshPower.obs,
		{ x: powerActor.cellX + 3, y: powerActor.cellY });
	result = await submitOne(otherAgentId, {
		type: 'move', actorIds: liveReserve.map(actor => actor.actorId),
		cellX: repairApproach.x, cellY: repairApproach.y, queued: false
	});
	assert(result.accepted, `repair-wave approach rejected: ${result.reason}`);
	const visiblePower = await waitFor('repair wave sees the fresh power plant', async () => {
		const candidate = await observation(otherAgentId);
		return candidate.actors.find(actor => actor.relationship === 'enemy' && actor.actorId === powerActor.actorId) ?? false;
	}, 60_000, 20);
	result = await submitOne(otherAgentId, {
		type: 'attack', actorIds: liveReserve.map(actor => actor.actorId),
		targetActorId: visiblePower.actorId, queued: false
	});
	assert(result.accepted, `power-plant damage order rejected: ${result.reason}`);
	const damagedPowerObservation = await waitFor('fresh power plant takes synchronized damage', async () => {
		const candidate = await observation(agentId);
		const actor = candidate.actors.find(entry => entry.actorId === powerActor.actorId);
		return actor != null && actor.health < powerBefore ? candidate : false;
	}, 60_000, 20);
	const damageSituation = damagedPowerObservation.situations.find(situation =>
		situation.id === 'T4' && situation.evidence.assetId === powerActor.actorId);
	assert(damageSituation != null && damageSituation.evidence.repairCostEstimate > 0 &&
		damageSituation.evidence.sellRefundEstimate > 0,
		`structure damage did not expose factual repair/sell estimates: ${JSON.stringify(damageSituation)}`);
	const repairBatch = await waitFor('autoRepair reflex fires for the damaged power plant', async () => {
		const batch = await reflexEvents(agentId, repairCursor);
		return batch.events.some(event => event.kind === 'autoRepair' &&
			event.actorIds.includes(powerActor.actorId)) ? batch : false;
	}, 30_000, 20);
	const repairEvent = repairBatch.events.find(event => event.kind === 'autoRepair' &&
		event.actorIds.includes(powerActor.actorId));
	assert(/automatic repair/.test(repairEvent.reason), `autoRepair event is not explicit: ${JSON.stringify(repairEvent)}`);
	liveReserve = (await observation(otherAgentId)).actors
		.filter(actor => reserveIds.includes(actor.actorId));
	await moveAndWait(otherAgentId, liveReserve.map(actor => actor.actorId), reserveHolding,
		'repair fixture attackers withdraw to the proven holding area', 36);
	console.log('OK autoRepair emits a labeled reflex through the validated repair order');

	// Reuse the second agent's existing air chain and five retreat Yaks instead of
	// building a duplicate chain after the four observer harvesters have stopped
	// earning. Move the three surviving defenders clear, then use the durable,
	// unarmed reserve-side HARV for fog-correct acquisition of the first base.
	const infantryRemote = shiftedCell(attritionAfter, ownYard, -12, 12);
	await moveAndWait(agentId, survivingSquad.map(actor => actor.actorId), infantryRemote,
		'first-agent infantry clears the durable air-target spotter lane', 64);
	const spotterWaypoints = [[4, 0], [0, 4], [-4, 0], [0, -4]]
		.map(([dx, dy]) => shiftedCell(attritionAfter, ownYard, dx, dy));
	assert(spotterWaypoints.every(cell =>
		(cell.x - ownYard.x) ** 2 + (cell.y - ownYard.y) ** 2 <= 16),
		`air-target spotter ring escaped sight range: ${JSON.stringify(spotterWaypoints)}`);
	let spotterOrderTick = -200;
	let spotterWaypointIndex = 0;
	await waitFor('reserve harvester reveals the first Construction Yard', async () => {
		const candidate = await observation(otherAgentId);
		if (candidate.actors.some(actor => actor.relationship === 'enemy' &&
			actor.actorId === ownYard.actorId))
			return candidate;

		if (candidate.worldTick - spotterOrderTick >= 100) {
			const waypoint = spotterWaypoints[spotterWaypointIndex++ % spotterWaypoints.length];
			const order = await submitOne(otherAgentId, {
				type: 'move', actorIds: [reserveSpotter.actorId],
				cellX: waypoint.x, cellY: waypoint.y, queued: false
			});
			assert(order.accepted, `durable air-target spotter move rejected: ${order.reason}`);
			spotterOrderTick = candidate.worldTick;
		}

		return false;
	}, 60_000, 20);
	await stopActors(otherAgentId, [reserveSpotter.actorId], 'durable air-target harvester');
	const liveAirGroup = (await observation(otherAgentId)).actors
		.filter(actor => retreatIds.includes(actor.actorId)).sort((a, b) => a.actorId - b.actorId);
	assert(liveAirGroup.length >= 1,
		`no retreat Yaks survived for airStrike: ${JSON.stringify(liveAirGroup)}`);
	result = await submitOne(otherAgentId, {
		type: 'assignGroup', name: 'cp2-air', actorIds: liveAirGroup.map(actor => actor.actorId)
	});
	assert(result.accepted, `air group assignment rejected: ${result.reason}`);
	const airCursor = (await missionEvents(otherAgentId)).latestSequence;
	const missionObservation = await waitFor('air mission target and spotter remain synchronized', async () => {
		const candidate = await observation(otherAgentId);
		const spotterAlive = candidate.actors.some(actor => actor.relationship === 'self' &&
			actor.actorId === reserveSpotter.actorId);
		const targetVisible = candidate.actors.some(actor => actor.relationship === 'enemy' &&
			actor.actorId === ownYard.actorId);
		return spotterAlive && targetVisible ? candidate : false;
	}, 60_000, 20);
	const airTargetBaselines = new Map(missionObservation.actors
		.filter(actor => actor.relationship === 'enemy' &&
			(actor.cellX - ownYard.x) ** 2 + (actor.cellY - ownYard.y) ** 2 <= 15 ** 2)
		.map(actor => [actor.actorId, actor.health]));
	assert(airTargetBaselines.size > 0, 'air-strike target area has no synchronized enemy actors');
	result = (await submitObserved(otherAgentId, missionObservation, [{
		type: 'queueMission', missionId: 'cp2-air-strike', missionType: 'airStrike', missionVersion: 1,
		groupName: 'cp2-air', cellX: ownYard.x, cellY: ownYard.y,
		sorties: 2, targetPriority: 'production', abortLossPercent: 80
	}])).results[0];
	assert(result.accepted, `two-sortie airStrike rejected: ${result.reason}`);
	let airSpotterOrderTick = missionObservation.worldTick;
	let airSpotterHadVisibility = true;
	let missionTraceTick = -1;
	const maintainAirSpotter = async candidate => {
		const spotterAlive = candidate.actors.some(actor => actor.relationship === 'self' &&
			actor.actorId === reserveSpotter.actorId);
		assert(spotterAlive, 'durable air-target spotter died during the airStrike');
		const targetVisible = candidate.actors.some(actor => actor.relationship === 'enemy' &&
			actor.actorId === ownYard.actorId);
		const visibilityLost = !targetVisible && airSpotterHadVisibility;
		if (targetVisible)
			airSpotterHadVisibility = true;
		else
			airSpotterHadVisibility = false;
		if (visibilityLost || candidate.worldTick - airSpotterOrderTick >= 75) {
			const waypoint = spotterWaypoints[spotterWaypointIndex++ % spotterWaypoints.length];
			const order = await submitOne(otherAgentId, {
				type: 'move', actorIds: [reserveSpotter.actorId],
				cellX: waypoint.x, cellY: waypoint.y, queued: false
			});
			assert(order.accepted, `airStrike spotter keepalive move rejected: ${order.reason}`);
			airSpotterOrderTick = candidate.worldTick;
		}
	};
	const traceAirMission = async worldTick => {
		if (worldTick - missionTraceTick < 100)
			return;
		missionTraceTick = worldTick;
		const batch = await missionEvents(otherAgentId, airCursor);
		const states = batch.events.filter(event => event.missionId === 'cp2-air-strike')
			.map(event => `${event.state}:${event.reason}`);
		console.log(`TRACE airStrike tick=${worldTick} states=${states.join('|')}`);
	};
	await waitFor('first air sortie reveals and damages its stable target', async () => {
		const candidate = await observation(otherAgentId);
		await maintainAirSpotter(candidate);
		await traceAirMission(candidate.worldTick);
		const target = candidate.actors.find(actor => actor.relationship === 'enemy' &&
			airTargetBaselines.has(actor.actorId) && actor.health < airTargetBaselines.get(actor.actorId));
		return target != null ? candidate : false;
	}, 240_000, 50);
	await waitFor('airStrike records attack, rearm, second sortie, and completion', async () => {
		const candidate = await observation(otherAgentId);
		await maintainAirSpotter(candidate);
		await traceAirMission(candidate.worldTick);
		const batch = await missionEvents(otherAgentId, airCursor);
		const events = batch.events.filter(event => event.missionId === 'cp2-air-strike');
		const launched = events.some(event => event.state === 'sortie(1)');
		const rearmed = events.some(event => event.state === 'rearming(1)' || /sortie 1 rearmed/.test(event.reason));
		const second = events.some(event => event.state === 'sortie(2)');
		const completed = events.some(event => event.state === 'completed' && /completed 2 sorties/.test(event.reason));
		return launched && rearmed && second && completed ? { batch, events } : false;
	}, 360_000, 100);
	console.log('OK airStrike completes two visible attack/rearm sorties through normal orders');

	// The same airfield exposes the real support power. Wait for readiness when
	// practical, then issue the normal SovietSpyPlane order against the known
	// enemy-base cell. This is deliberately last so its charge overlaps every
	// earlier fixture instead of extending wall time by the full interval.
	const spyReady = await waitFor('SovietSpyPlane becomes ready', async () => {
		const candidate = await observation(otherAgentId);
		return candidate.hostTruth.supportPowers?.find(power =>
			power.orderName === 'SovietSpyPlane' && power.ready) ? candidate : false;
	}, 300_000, 100);
	result = await submitOne(otherAgentId, { type: 'spyPlane', cellX: ownYard.x, cellY: ownYard.y });
	assert(result.accepted && result.reason === 'accepted',
		`ready SovietSpyPlane activation rejected: ${JSON.stringify(result)}`);
	assert(spyReady.hostTruth.supportPowers.some(power => power.orderName === 'SovietSpyPlane' && power.ready),
		'ready support-power fact disappeared before activation');
	await waitFor('SovietSpyPlane charge is consumed and reset', async () => {
		const candidate = await observation(otherAgentId);
		const power = candidate.hostTruth.supportPowers?.find(entry => entry.orderName === 'SovietSpyPlane');
		return power != null && !power.ready && Number.isInteger(power.remainingSeconds) &&
			power.remainingSeconds > 0 ? candidate : false;
	}, 60_000, 20);
	console.log('OK ready SovietSpyPlane activates through its synchronized support-power order');

	const terminalObservation = await observation(agentId);
	result = await submitOne(agentId, { type: 'surrender' }, 'End the CP2 combat gate.');
	assert(result.accepted, `surrender rejected: ${result.reason}`);
	const terminal = await waitFor('CP2 combat fixture resolves without OOS', async () => {
		const candidate = await state();
		return candidate.state === 'finished' ? candidate : false;
	}, 60_000, 100);
	assert(!terminal.outOfSync && terminal.worldTick >= terminalObservation.worldTick && terminal.netFrame > 0,
		`terminal lockstep state is invalid: ${JSON.stringify(terminal)}`);
	const surrendered = terminal.agents.find(agent => agent.agentId === agentId);
	const victor = terminal.agents.find(agent => agent.agentId === otherAgentId);
	assert(surrendered?.winState === 'Lost' && victor?.winState === 'Won',
		`terminal win states are invalid: ${JSON.stringify(terminal)}`);
	console.log(`CP2 COMBAT GATE RESULT: PASS tick=${terminal.worldTick} net=${terminal.netFrame}`);
} catch (error) {
	console.error('CP2 COMBAT GATE FAILED:', error.message);
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
