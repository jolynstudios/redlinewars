// A2a phase-1 browser gate: drives a real two-agent match through the public
// host API with a deterministic scripted policy. It validates the enriched
// observation contract, manual and automatic building placement, and sync.
// Usage: node a2a-gate.mjs [--headed]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const httpPort = 8357;
const BootUrl = `http://127.0.0.1:${httpPort}/index.html?mode=game&platform=webgl2&Host.DevContent=1&Host.AgentMode=1&Launch.Map=Siberian-Pass.oramap&Debug.ServerRandomSeed=23456`;
const MaxObservationBytes = 256 * 1024;

const server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'inherit' });
await new Promise(resolve => setTimeout(resolve, 1000));

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage();
page.on('pageerror', error => console.error('[pageerror]', String(error)));
page.on('console', message => {
	if (/\[host\]|FATAL|agent|PASS|FAIL/i.test(message.text())) {
		console.log(`[console] ${message.text().slice(0, 240)}`);
	}
});

let agentId;
let decisionId = 1;
let lastObservation;
let otherAgentId;
let otherDecisionId = 1;
let otherLastObservation;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

async function hostJson(method, ...args) {
	const raw = await page.evaluate(({ method, args }) => globalThis.ora[method](...args), { method, args });
	const value = JSON.parse(raw);
	if (value?.error) {
		throw new Error(`${method}: ${value.error}`);
	}

	return { raw, value };
}

async function state() {
	const { value } = await hostJson('GetAgentMatchState');
	if (value.outOfSync) {
		throw new Error(`DESYNC at tick ${value.worldTick}, net ${value.netFrame}`);
	}

	if (value.state === 'failed') {
		throw new Error(`Agent match failed: ${value.terminalReason ?? value.fakeAgentStatus}`);
	}

	return value;
}

async function audioSnapshot() {
	return page.evaluate(() => ({
		state: globalThis.openraAudioDebug?.state(),
		voicesStarted: globalThis.openraAudioDebug?.voicesStarted
	}));
}

async function waitFor(label, predicate, timeoutMs = 240_000, intervalMs = 200) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	while (Date.now() < deadline) {
		latest = await predicate();
		if (latest) {
			console.log(`OK ${label}`);
			return latest;
		}

		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}

	throw new Error(`TIMEOUT ${label}; latest=${JSON.stringify(latest)}`);
}

async function observation() {
	const { raw, value } = await hostJson('GetAgentObservation', agentId, 0);
	const size = Buffer.byteLength(raw, 'utf8');
	assert(size < MaxObservationBytes, `observation is ${size} bytes (limit ${MaxObservationBytes})`);
	assertActorCapsAndOrdering(value);
	for (const queue of value.productionQueues) {
		assert(Number.isInteger(queue.producerId), `production queue is missing integer producerId: ${JSON.stringify(queue)}`);
		assert(!Object.hasOwn(queue, 'actorId'), `production queue retained ambiguous actorId: ${JSON.stringify(queue)}`);
	}
	lastObservation = value;
	await state();
	return value;
}

async function decisionDue() {
	const { value } = await hostJson('GetAgentDecisionDue', agentId);
	assert(typeof value.due === 'boolean' && Number.isInteger(value.worldTick),
		`decision-due contract is invalid: ${JSON.stringify(value)}`);
	return value;
}

function assertHostTruthMatchesActors(obs) {
	assert(obs.hostTruth != null && obs.hostTruth.economy != null, 'host-truth ledger is missing');
	assert(obs.hostTruth.knownEnemyStructureCount === 0,
		`M1 known-enemy placeholder changed: ${obs.hostTruth.knownEnemyStructureCount}`);
	for (const [type, count] of Object.entries(obs.hostTruth.buildingCounts)) {
		const observed = obs.actors.filter(actor => actor.relationship === 'self' && actor.type === type).length;
		assert(observed <= count, `actor-list ${type} count ${observed} exceeds host-truth census ${count}`);
		if (!obs.truncated) {
			assert(observed === count, `host-truth ${type} count ${count} != actor-list count ${observed}`);
		}
	}

	assert(Array.isArray(obs.hostTruth.recentCriticalEvents) && obs.hostTruth.recentCriticalEvents.length <= 3,
		'host-truth recent critical events are missing or unbounded');
}

function assertActorCapsAndOrdering(obs) {
	assert(typeof obs.truncated === 'boolean', 'observation truncated flag is missing');
	assert(obs.actors.filter(actor => actor.relationship === 'self').length <= 64, 'self actor cap exceeded');
	assert(obs.actors.filter(actor => actor.relationship === 'enemy').length <= 48, 'enemy actor cap exceeded');
	assert(obs.actors.filter(actor => actor.relationship === 'ally').length <= 16, 'ally actor cap exceeded');

	const yards = obs.base?.yards ?? [];
	const distanceToBase = actor => yards.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...yards.map(yard =>
		(actor.cellX - yard.x) ** 2 + (actor.cellY - yard.y) ** 2));
	const enemies = obs.actors.filter(actor => actor.relationship === 'enemy');
	for (let i = 1; i < enemies.length; i++) {
		const previousDistance = distanceToBase(enemies[i - 1]);
		const currentDistance = distanceToBase(enemies[i]);
		assert(previousDistance < currentDistance ||
			(previousDistance === currentDistance && enemies[i - 1].actorId < enemies[i].actorId),
			`enemy observations are not nearest-base-first: ${JSON.stringify(enemies.slice(i - 1, i + 1))}`);
	}

	assert(obs.hostTruth.knownEnemyStructureCount === obs.knownEnemyStructures.length,
		`known-enemy census mismatch: ${obs.hostTruth.knownEnemyStructureCount} != ${obs.knownEnemyStructures.length}`);
	assert(obs.knownEnemyStructures.every(known => known.status === 'last-known' &&
		Number.isInteger(known.lastSeenTick) && known.lastSeenTick <= obs.worldTick &&
		Number.isInteger(known.cell?.x) && Number.isInteger(known.cell?.y)),
		`known-enemy structure contract is invalid: ${JSON.stringify(obs.knownEnemyStructures)}`);
	assert(Array.isArray(obs.groups) && obs.groups.length <= 16 && obs.groups.every(group =>
		typeof group.name === 'string' && group.name.length >= 1 && group.name.length <= 24 &&
		group.liveCount === group.actorIds.length && group.actorIds.every(Number.isInteger)),
		`group observation contract is invalid: ${JSON.stringify(obs.groups)}`);

	const spatial = obs.spatial;
	assert(spatial?.gridWidth === 16 && spatial.gridHeight === 16 && spatial.grid.length === 16 &&
		spatial.grid.every(row => typeof row === 'string' && row.length === 16 && /^[?.F$KABOE!]+$/.test(row)),
		`spatial grid is invalid: ${JSON.stringify(spatial)}`);
	assert(spatial.columns.length === 16 && spatial.rows.length === 16 &&
		spatial.columns[0].cellStartInclusive === obs.mapMinX &&
		spatial.columns[15].cellEndExclusive === obs.mapMaxX + 1 &&
		spatial.rows[0].cellStartInclusive === obs.mapMinY &&
		spatial.rows[15].cellEndExclusive === obs.mapMaxY + 1,
		`spatial grid-to-cell bounds are invalid: ${JSON.stringify(spatial)}`);
	assert(spatial.legend.includes('$ explored resource') && spatial.legend.includes('K known enemy structure'),
		`spatial legend is incomplete: ${spatial.legend}`);
	assert(spatial.contactLines.length <= 6 && spatial.frontLines.length <= 3 &&
		[...spatial.contactLines, ...spatial.frontLines].every(line => line.length <= 120),
		`spatial summaries are unbounded: ${JSON.stringify(spatial)}`);
}

async function submit(action, thoughts = 'A2a deterministic scripted gate action.') {
	const obs = lastObservation ?? await observation();
	const batch = {
		schemaVersion: 1,
		decisionId: decisionId++,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts,
		actions: [action]
	};
	const { value } = await hostJson('SubmitAgentActions', agentId, JSON.stringify(batch));
	assert(Array.isArray(value.results) && value.results.length === 1, `unexpected action result: ${JSON.stringify(value)}`);
	return value.results[0];
}

async function otherObservation() {
	const { raw, value } = await hostJson('GetAgentObservation', otherAgentId, 0);
	assert(Buffer.byteLength(raw, 'utf8') < MaxObservationBytes, 'second-agent observation exceeds 256 KiB');
	assertActorCapsAndOrdering(value);
	otherLastObservation = value;
	await state();
	return value;
}

async function otherSubmit(action, thoughts = 'A2a deterministic second-agent gate action.') {
	const obs = otherLastObservation ?? await otherObservation();
	const batch = {
		schemaVersion: 1,
		decisionId: otherDecisionId++,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts,
		actions: [action]
	};
	const { value } = await hostJson('SubmitAgentActions', otherAgentId, JSON.stringify(batch));
	assert(Array.isArray(value.results) && value.results.length === 1,
		`unexpected second-agent action result: ${JSON.stringify(value)}`);
	return value.results[0];
}

async function waitForOtherReadyBuilding(item) {
	return waitFor(`second-agent ${item} production becomes placeable`, async () => {
		const obs = await otherObservation();
		const queue = findQueue(obs, item);
		const queued = queue?.items.find(entry => entry.item === item);
		return queued?.placeable ? { obs, queue, queued } : false;
	}, 240_000, 250);
}

async function reflexEvents(id, sinceSequence = 0) {
	const { value } = await hostJson('GetAgentReflexEvents', id, sinceSequence);
	assert(Number.isInteger(value.latestSequence) && Array.isArray(value.events),
		`reflex-event contract is invalid: ${JSON.stringify(value)}`);
	return value;
}

async function buildPlanEvents(id, sinceSequence = 0) {
	const { value } = await hostJson('GetAgentBuildPlanEvents', id, sinceSequence);
	assert(Number.isInteger(value.latestSequence) && Array.isArray(value.events),
		`build-plan event contract is invalid: ${JSON.stringify(value)}`);
	return value;
}

function findQueue(obs, item) {
	return obs.productionQueues.find(queue => queue.buildableItems.includes(item));
}

async function produceOtherInfantryWave(label, count = 5) {
	const before = await otherObservation();
	const queue = findQueue(before, 'e1');
	assert(queue != null, `${label}: second-agent infantry queue disappeared`);
	const existingIds = new Set(before.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1')
		.map(actor => actor.actorId));
	const production = await otherSubmit({
		type: 'startProduction',
		producerId: queue.producerId,
		item: 'e1',
		count,
		queued: false
	});
	assert(production.accepted, `${label}: infantry production rejected: ${production.reason}`);

	const emerged = await waitFor(label, async () => {
		const candidate = await otherObservation();
		const fresh = candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1' &&
			!existingIds.has(actor.actorId)).sort((a, b) => a.actorId - b.actorId);
		return fresh.length >= count ? fresh.slice(-count) : false;
	}, 240_000, 20);
	return emerged;
}

async function waitForReadyBuilding(item) {
	const etaSamples = [];
	const ready = await waitFor(`${item} production becomes placeable`, async () => {
		const obs = await observation();
		const queue = findQueue(obs, item);
		const queued = queue?.items.find(entry => entry.item === item);
		if (queued == null) {
			return false;
		}

		assert(typeof queued.paused === 'boolean', 'queue item paused is missing');
		assert(Number.isInteger(queued.etaSeconds), 'queue item etaSeconds is missing');
		assert(typeof queued.placeable === 'boolean', 'queue item placeable is missing');
		etaSamples.push(queued.etaSeconds);
		if (!queued.placeable) {
			return false;
		}

		assert(obs.advisorHints.some(hint => hint.startsWith('READY:')), 'READY advisor hint is missing');
		return { obs, queue, queued };
	}, 240_000, 250);

	assert(etaSamples.some((eta, index) => index > 0 && eta < etaSamples[index - 1]),
		`etaSeconds did not count down: ${etaSamples.join(',')}`);
	return ready;
}

function placementCandidates(obs) {
	const yard = obs.base.yards[0];
	const radius = obs.base.buildRadius;
	const cells = [];
	for (let y = Math.max(obs.mapMinY, yard.y - radius); y <= Math.min(obs.mapMaxY, yard.y + radius); y++) {
		for (let x = Math.max(obs.mapMinX, yard.x - radius); x <= Math.min(obs.mapMaxX, yard.x + radius); x++) {
			const dx = x - yard.x;
			const dy = y - yard.y;
			if (dx * dx + dy * dy >= 4) {
				cells.push({ x, y, distance: dx * dx + dy * dy });
			}
		}
	}

	return cells.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
}

try {
	await page.goto(BootUrl);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	console.log('booted in AgentMode');
	const audioBeforeUnlock = await audioSnapshot();
	assert(audioBeforeUnlock.state === 'suspended' && Number.isInteger(audioBeforeUnlock.voicesStarted),
		`audio debug state before trusted gesture is invalid: ${JSON.stringify(audioBeforeUnlock)}`);
	await page.click('#debug-toggle');
	await waitFor('trusted page control unlocks browser audio', async () => {
		const snapshot = await audioSnapshot();
		return snapshot.state === 'running' ? snapshot : false;
	}, 30_000, 20);

	const actionSchema = await hostJson('GetAgentActionSchema');
	for (const action of ['queueBuildPlan', 'controlBuildPlan', 'assignGroup', 'placeBuildingAuto', 'capture',
		'cancelProduction', 'setRallyPoint', 'repair', 'sell', 'setPolicy']) {
		assert(actionSchema.value.actions.some(entry => entry.type === action), `${action} is missing from the action schema`);
	}
	const captureSchema = actionSchema.value.actions.find(action => action.type === 'capture');
	assert(captureSchema.note.includes('currently visible'), 'capture visibility policy is missing from the action schema');

	const start = await hostJson('StartAgentMatch', '', JSON.stringify({
		schemaVersion: 1,
		fakeAgents: false,
		decisionIntervalTicks: 25,
		faction1: 'russia',
		faction2: 'russia'
	}));
	assert(start.value.agentIds.length === 2, `expected two agent ids: ${start.raw}`);
	agentId = start.value.agentIds[0];
	otherAgentId = start.value.agentIds[1];

	await waitFor('regular agent world', async () => {
		const current = await state();
		return current.state === 'running' && current.worldTick >= 25;
	});

	let due = await decisionDue();
	assert(due.due && due.trigger === 'heartbeat', `first decision was not a heartbeat: ${JSON.stringify(due)}`);
	let obs = await observation();
	assert(obs.decisionTrigger === 'heartbeat', `observation did not carry the claimed heartbeat: ${obs.decisionTrigger}`);
	assert(obs.player.faction === 'russia', `expected configured faction russia, got ${obs.player.faction}`);
	const secondAgentObservation = await hostJson('GetAgentObservation', start.value.agentIds[1], 0);
	assert(secondAgentObservation.value.player.faction === 'russia',
		`expected second configured faction russia, got ${secondAgentObservation.value.player.faction}`);
	assert(obs.base != null && Array.isArray(obs.base.yards) && Number.isInteger(obs.base.buildRadius), 'base observation missing');
	assert(obs.scouting != null && Number.isInteger(obs.scouting.exploredPercent) &&
		Array.isArray(obs.scouting.frontier) && obs.scouting.frontier.length <= 3, 'scouting observation missing or invalid');
	assert(Array.isArray(obs.advisorHints) && obs.advisorHints.length <= 6 &&
		obs.advisorHints.every(hint => hint.length <= 120), 'advisor hints are missing or unbounded');
	assert(Array.isArray(obs.alerts), 'alerts collection is missing');
	assertHostTruthMatchesActors(obs);
	assert(obs.hostTruth.standingPolicy.autoReturnFire && obs.hostTruth.standingPolicy.harvesterFlee &&
		!obs.hostTruth.standingPolicy.rallyNewUnitsToDefense && obs.hostTruth.standingPolicy.defendCriticalAssets &&
		obs.hostTruth.standingPolicy.retreatBelowHpPercent === 0,
		`default standing policy changed: ${JSON.stringify(obs.hostTruth.standingPolicy)}`);
	assert(obs.actors.filter(actor => actor.relationship === 'self').every(actor => typeof actor.idle === 'boolean'),
		'own actor idle flags are missing');
	assert(obs.base.buildRadius === 7, `expected RA build radius 7, got ${obs.base.buildRadius}`);
	let result = await submit({
		type: 'setPolicy',
		autoReturnFire: false,
		harvesterFlee: false,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: true,
		autoRepairBuildings: false,
		retreatBelowHpPercent: 20
	});
	assert(result.accepted && result.reason === 'accepted; standing orders updated',
		`standing policy update failed: ${JSON.stringify(result)}`);
	obs = await observation();
	assert(!obs.hostTruth.standingPolicy.autoReturnFire && !obs.hostTruth.standingPolicy.harvesterFlee &&
		!obs.hostTruth.standingPolicy.rallyNewUnitsToDefense && obs.hostTruth.standingPolicy.defendCriticalAssets &&
		!obs.hostTruth.standingPolicy.autoRepairBuildings &&
		obs.hostTruth.standingPolicy.retreatBelowHpPercent === 20,
		`standing policy was not recorded in host truth: ${JSON.stringify(obs.hostTruth.standingPolicy)}`);

	const deployable = obs.actors.find(actor => actor.relationship === 'self' && actor.capabilities.includes('deploy'));
	assert(deployable != null, 'no deployable MCV was observed');
	result = await submit({ type: 'capture', actorIds: [deployable.actorId], targetActorId: 0xffffffff, queued: false });
	assert(!result.accepted && result.reason === 'target actor is stale, missing, or not visible to this agent',
		`capture stale/hidden rejection changed: ${JSON.stringify(result)}`);
	lastObservation = await observation();
	result = await submit({
		type: 'capture',
		actorIds: [deployable.actorId],
		targetActorId: deployable.actorId,
		producerId: deployable.actorId,
		queued: false
	});
	assert(!result.accepted && result.reason === 'capture requires only actorIds, targetActorId, and optional queued',
		`capture field-purity rejection changed: ${JSON.stringify(result)}`);
	console.log('capture validation PASS; full capture omitted because the gate has no visible capturable enemy and engineer');

	result = await submit({ type: 'deploy', actorIds: [deployable.actorId] });
	assert(result.accepted, `deploy rejected: ${result.reason}`);

	obs = await waitFor('Construction Yard appears in base.yards', async () => {
		const candidate = await observation();
		return candidate.base.yards.length > 0 ? candidate : false;
	});
	assert(obs.base.yards.some(yard => Number.isInteger(yard.actorId) && Number.isInteger(yard.x) && Number.isInteger(yard.y)),
		'base yard fields are invalid');
	const yard = obs.base.yards[0];
	const yardActor = obs.actors.find(actor => actor.actorId === yard.actorId);
	assert(yardActor != null && !yardActor.capabilities.includes('deploy'),
		`Construction Yard still advertises deploy: ${JSON.stringify(yardActor)}`);
	assert(!obs.advisorHints.some(hint => hint.includes(`Deploy actor ${yard.actorId}`)),
		`advisor still recommends undeploying the Construction Yard: ${JSON.stringify(obs.advisorHints)}`);
	lastObservation = obs;
	result = await submit({ type: 'deploy', actorIds: [yard.actorId] });
	assert(!result.accepted && result.reason === `actor ${yard.actorId} is a deployed structure; deploying would undeploy it. ` +
		'Buildings are produced via startProduction + placeBuildingAuto.',
		`deployed structure was allowed to undeploy: ${JSON.stringify(result)}`);

	const powerQueue = await waitFor('power production queue', async () => {
		const candidate = await observation();
		return findQueue(candidate, 'powr') ?? false;
	});
	lastObservation = await observation();
	result = await submit({ type: 'startProduction', producerId: yard.actorId, item: 'powr', count: 1, queued: false });
	assert(result.accepted, `Construction Yard production alias rejected: ${result.reason}`);
	lastObservation = await waitFor('power item enters the production queue before cancellation', async () => {
		const candidate = await observation();
		return findQueue(candidate, 'powr')?.items.some(item => item.item === 'powr') ? candidate : false;
	});
	result = await submit({ type: 'cancelProduction', producerId: yard.actorId, item: 'powr', count: 1 });
	assert(result.accepted, `Construction Yard cancellation alias rejected: ${result.reason}`);
	await waitFor('cancelled power leaves the production queue', async () => {
		const candidate = await observation();
		return findQueue(candidate, 'powr')?.items.some(item => item.item === 'powr') ? false : candidate;
	});
	lastObservation = await observation();
	result = await submit({ type: 'startProduction', producerId: powerQueue.producerId, item: 'powr', count: 1, queued: false });
	assert(result.accepted, `direct queue-owner power production rejected: ${result.reason}`);
	lastObservation = await waitFor('premature placement ETA sample', async () => {
		const candidate = await observation();
		const item = findQueue(candidate, 'powr')?.items.find(entry => entry.item === 'powr');
		const remainder = item?.remainingTime % 25;
		return item != null && !item.placeable && remainder >= 8 && remainder <= 16 ? candidate : false;
	}, 10_000, 20);
	const pendingPower = findQueue(lastObservation, 'powr')?.items.find(item => item.item === 'powr');
	assert(pendingPower != null && !pendingPower.placeable && pendingPower.etaSeconds > 0,
		`premature power fixture is not in progress: ${JSON.stringify(pendingPower)}`);
	result = await submit({ type: 'placeBuildingAuto', producerId: powerQueue.producerId, item: 'powr' });
	assert(!result.accepted && result.reason === `building 'powr' is not ready on actor ${powerQueue.producerId}; ` +
		`~${pendingPower.etaSeconds}s remain — wait for placeable:true`,
		`premature auto-place wording changed: ${JSON.stringify(result)}`);
	let ready = await waitForReadyBuilding('powr');

	let manualResult;
	for (const cell of placementCandidates(ready.obs)) {
		lastObservation = await observation();
		manualResult = await submit({
			type: 'placeBuilding',
			producerId: ready.queue.producerId,
			item: 'powr',
			cellX: cell.x,
			cellY: cell.y
		});
		if (manualResult.accepted) {
			console.log(`manual placement accepted at ${cell.x},${cell.y}`);
			break;
		}
	}
	assert(manualResult?.accepted, `no manual powr placement succeeded; last=${JSON.stringify(manualResult)}`);

	const manualPowerObservation = await waitFor('manually placed powr actor finishes construction', async () => {
		const candidate = await observation();
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === 'powr' &&
			actor.capabilities.includes('sell')) ? candidate : false;
	});
	const manualPower = manualPowerObservation.actors.find(actor => actor.relationship === 'self' && actor.type === 'powr' &&
		actor.capabilities.includes('sell'));
	assert(manualPower.capabilities.includes('sell'), 'eligible power building does not advertise sell');
	lastObservation = manualPowerObservation;
	result = await submit({ type: 'repair', actorIds: [manualPower.actorId] });
	assert(!result.accepted && result.reason === `actor ${manualPower.actorId} is not a damaged repairable building`,
		`undamaged repair rejection changed: ${JSON.stringify(result)}`);

	const barrQueue = findQueue(manualPowerObservation, 'barr');
	assert(barrQueue != null, 'barracks queue is unavailable after power placement');
	lastObservation = manualPowerObservation;
	result = await submit({ type: 'startProduction', producerId: barrQueue.producerId, item: 'barr', count: 1, queued: false });
	assert(result.accepted, `barracks production rejected: ${result.reason}`);
	const readyBarracks = await waitForReadyBuilding('barr');
	lastObservation = readyBarracks.obs;
	result = await submit({ type: 'placeBuildingAuto', producerId: readyBarracks.queue.producerId, item: 'barr' });
	assert(result.accepted, `barracks placement rejected: ${result.reason}`);
	const barracksObservation = await waitFor('placed barracks appears', async () => {
		const candidate = await observation();
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === 'barr') ? candidate : false;
	});
	const barracks = barracksObservation.actors.find(actor => actor.relationship === 'self' && actor.type === 'barr');
	lastObservation = barracksObservation;
	result = await submit({ type: 'startProduction', producerId: barracks.actorId, item: 'powr', count: 1, queued: false });
	assert(!result.accepted && result.reason === `actor ${barracks.actorId} cannot build 'powr'; ` +
		`use producerId ${powerQueue.producerId} from productionQueues (queue '${powerQueue.queueType}' can build it)`,
		`wrong-queue guidance changed: ${JSON.stringify(result)}`);

	lastObservation = await observation();
	result = await submit({
		type: 'setRallyPoint',
		producerId: powerQueue.producerId,
		cellX: manualPower.cellX,
		cellY: manualPower.cellY
	});
	assert(!result.accepted && result.reason === `actor ${powerQueue.producerId} cannot set a rally point`,
		`non-rally producer rejection changed: ${JSON.stringify(result)}`);

	obs = await observation();
	const firstPowerCount = obs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'powr').length;
	const secondQueue = findQueue(obs, 'powr');
	assert(secondQueue != null, 'power queue disappeared after manual placement');
	result = await submit({ type: 'startProduction', producerId: secondQueue.producerId, item: 'powr', count: 1, queued: false });
	assert(result.accepted, `second power production rejected: ${result.reason}`);
	ready = await waitForReadyBuilding('powr');
	lastObservation = ready.obs;
	result = await submit({ type: 'placeBuildingAuto', producerId: yard.actorId, item: 'powr' });
	assert(result.accepted, `auto-placement rejected: ${result.reason}`);
	assert(/^accepted; placing powr at cell -?\d+,-?\d+$/.test(result.reason),
		`auto-placement success reason is not informative: ${result.reason}`);

	await waitFor('automatically placed powr actor exists', async () => {
		const candidate = await observation();
		return candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'powr').length > firstPowerCount
			? candidate
			: false;
	});

	obs = await observation();
	const sellablePower = obs.actors.find(actor => actor.relationship === 'self' && actor.type === 'powr' &&
		actor.capabilities.includes('sell'));
	assert(sellablePower != null, 'no sellable power building was observed');
	lastObservation = obs;
	result = await submit({ type: 'assignGroup', name: 'obsolete-power', actorIds: [sellablePower.actorId] });
	assert(result.accepted && result.reason === "accepted; group 'obsolete-power' assigned 1 actors",
		`group assignment rejected: ${JSON.stringify(result)}`);
	obs = await observation();
	assert(obs.groups.some(group => group.name === 'obsolete-power' && group.actorIds[0] === sellablePower.actorId),
		`assigned group was not observed: ${JSON.stringify(obs.groups)}`);
	const powerCountBeforeSell = obs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'powr').length;
	lastObservation = obs;
	result = await submit({ type: 'sell', actorIds: [sellablePower.actorId] });
	assert(result.accepted, `sell rejected: ${result.reason}`);
	await waitFor('sell removes the selected power actor and culls its group', async () => {
		const candidate = await observation();
		return candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'powr').length < powerCountBeforeSell &&
			!candidate.groups.some(group => group.name === 'obsolete-power')
			? candidate
			: false;
	});

	obs = await observation();
	const refineryQueue = findQueue(obs, 'proc');
	assert(refineryQueue != null, 'refinery queue is unavailable for the event-bus gate');
	lastObservation = obs;
	result = await submit({ type: 'startProduction', producerId: refineryQueue.producerId, item: 'proc', count: 1, queued: false });
	assert(result.accepted, `refinery production rejected: ${result.reason}`);
	const readyRefinery = await waitForReadyBuilding('proc');
	lastObservation = readyRefinery.obs;
	result = await submit({
		type: 'queueBuildPlan',
		planId: 'dirty-queue',
		version: 1,
		reserveCash: 0,
		steps: [{ item: 'powr', count: 1 }]
	});
	assert(!result.accepted && /cannot start build plan while producer \d+ has queued 'proc'/.test(result.reason),
		`build plan acquired a manually-owned ready queue: ${JSON.stringify(result)}`);
	lastObservation = await observation();
	result = await submit({ type: 'placeBuildingAuto', producerId: readyRefinery.queue.producerId, item: 'proc' });
	assert(result.accepted, `refinery placement rejected: ${result.reason}`);
	const refineryObservation = await waitFor('placed refinery appears', async () => {
		const candidate = await observation();
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === 'proc' &&
			actor.capabilities.includes('sell')) ? candidate : false;
	});
	assertHostTruthMatchesActors(refineryObservation);
	assert(Number.isInteger(refineryObservation.hostTruth.completedMilestones.proc),
		`proc milestone is missing: ${JSON.stringify(refineryObservation.hostTruth.completedMilestones)}`);
	assert(refineryObservation.hostTruth.refineryCount >= 1, 'refineryCount did not include the placed refinery');
	const refinery = refineryObservation.actors.find(actor => actor.relationship === 'self' && actor.type === 'proc' &&
		actor.capabilities.includes('sell'));
	lastObservation = refineryObservation;
	result = await submit({ type: 'sell', actorIds: [refinery.actorId] });
	assert(result.accepted, `refinery sell rejected: ${result.reason}`);
	const afterRefineryLoss = await waitFor('refinery loss edge', async () => {
		const candidate = await observation();
		return candidate.actors.some(actor => actor.actorId === refinery.actorId) ? false : candidate;
	}, 120_000, 50);
	due = await waitFor('critical loss schedules an immediate decision', async () => {
		const candidate = await decisionDue();
		return candidate.due ? candidate : false;
	}, 10_000, 20);
	assert(due.trigger === 'criticalAssetLost', `critical loss trigger was coalesced incorrectly: ${JSON.stringify(due)}`);
	assert(due.worldTick - afterRefineryLoss.worldTick <= 5,
		`critical loss decision was delayed ${due.worldTick - afterRefineryLoss.worldTick} ticks`);
	const alertObservation = await observation();
	assert(alertObservation.decisionTrigger === 'criticalAssetLost',
		`alert observation trigger changed: ${alertObservation.decisionTrigger}`);
	const lossAlert = alertObservation.alerts.find(alert =>
		alert.kind === 'criticalAssetLost' && alert.affectedActorId === refinery.actorId);
	assert(lossAlert != null, `critical refinery-loss alert is missing: ${JSON.stringify(alertObservation.alerts)}`);
	assert(lossAlert.severity === 'critical' && lossAlert.stillActive && Number.isInteger(lossAlert.firstSeenTick),
		`critical refinery-loss alert fields are invalid: ${JSON.stringify(lossAlert)}`);
	assert(lossAlert.cell != null && Number.isInteger(lossAlert.cell.x) && Number.isInteger(lossAlert.cell.y),
		`critical refinery-loss cell is invalid: ${JSON.stringify(lossAlert)}`);
	assert(lossAlert.threat != null && /visible estimate/.test(lossAlert.threat.summary) &&
		['weak', 'even', 'strong'].includes(lossAlert.threat.verdict),
		`critical refinery-loss threat estimate is invalid: ${JSON.stringify(lossAlert.threat)}`);
	assertHostTruthMatchesActors(alertObservation);
	assert(alertObservation.hostTruth.recentCriticalEvents.some(event =>
		event.kind === 'criticalAssetLost' && event.actorId === refinery.actorId),
		'critical refinery loss was not recorded in the host-truth ledger');

	// Build the second agent's minimal infantry attack fixture through the same
	// public order API used by real models.
	let otherObs = await otherObservation();
	const otherMcv = otherObs.actors.find(actor => actor.relationship === 'self' && actor.capabilities.includes('deploy'));
	assert(otherMcv != null, 'second agent has no deployable MCV');
	result = await otherSubmit({ type: 'deploy', actorIds: [otherMcv.actorId] });
	assert(result.accepted, `second-agent deploy rejected: ${result.reason}`);
	otherObs = await waitFor('second-agent Construction Yard appears', async () => {
		const candidate = await otherObservation();
		return candidate.base.yards.length > 0 ? candidate : false;
	});
	const otherYard = otherObs.base.yards[0];
	let otherQueue = await waitFor('second-agent power queue becomes available', async () => {
		const candidate = await otherObservation();
		return findQueue(candidate, 'powr') ?? false;
	});
	result = await otherSubmit({ type: 'startProduction', producerId: otherQueue.producerId, item: 'powr', count: 1, queued: false });
	assert(result.accepted, `second-agent power production rejected: ${result.reason}`);
	let otherReady = await waitForOtherReadyBuilding('powr');
	otherLastObservation = otherReady.obs;
	result = await otherSubmit({ type: 'placeBuildingAuto', producerId: otherReady.queue.producerId, item: 'powr' });
	assert(result.accepted, `second-agent power placement rejected: ${result.reason}`);
	otherObs = await waitFor('second-agent power actor appears', async () => {
		const candidate = await otherObservation();
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === 'powr') ? candidate : false;
	});
	otherQueue = await waitFor('second-agent barracks queue becomes available', async () => {
		const candidate = await otherObservation();
		return findQueue(candidate, 'barr') ?? false;
	});
	result = await otherSubmit({ type: 'startProduction', producerId: otherQueue.producerId, item: 'barr', count: 1, queued: false });
	assert(result.accepted, `second-agent barracks production rejected: ${result.reason}`);
	otherReady = await waitForOtherReadyBuilding('barr');
	otherLastObservation = otherReady.obs;
	result = await otherSubmit({ type: 'placeBuildingAuto', producerId: otherReady.queue.producerId, item: 'barr' });
	assert(result.accepted, `second-agent barracks placement rejected: ${result.reason}`);
	otherObs = await waitFor('second-agent barracks appears', async () => {
		const candidate = await otherObservation();
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === 'barr') ? candidate : false;
	});
	otherQueue = await waitFor('second-agent infantry queue becomes available', async () => {
		const candidate = await otherObservation();
		return findQueue(candidate, 'e1') ?? false;
	});
	const otherInfantryBefore = otherObs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1').length;
	result = await otherSubmit({ type: 'startProduction', producerId: otherQueue.producerId, item: 'e1', count: 5, queued: false });
	assert(result.accepted, `second-agent infantry production rejected: ${result.reason}`);
	otherObs = await waitFor('second-agent attack infantry appear', async () => {
		const candidate = await otherObservation();
		return candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1').length >=
			otherInfantryBefore + 5 ? candidate : false;
	});
	let attackers = otherObs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1')
		.sort((a, b) => a.actorId - b.actorId).slice(-5);
	assert(attackers.length === 5, 'second-agent infantry fixture did not produce five attackers');

	// Start the critical-building fixture before the cross-map march so its
	// production overlaps travel instead of exposing staged infantry to base traffic.
	obs = await observation();
	let fixtureQueue = findQueue(obs, 'proc');
	assert(fixtureQueue != null, 'first-agent refinery queue disappeared');
	result = await submit({ type: 'startProduction', producerId: fixtureQueue.producerId, item: 'proc', count: 1, queued: false });
	assert(result.accepted, `fixture refinery production rejected: ${result.reason}`);

	// Move the attackers near the first base before creating the reflex subjects.
	// This keeps the lease clock deterministic and avoids spending it on map travel.
	const approachOffset = 2;
	const deltaX = otherYard.x - yard.x;
	const deltaY = otherYard.y - yard.y;
	const approach = Math.abs(deltaX) >= Math.abs(deltaY) ? {
		x: yard.x + Math.sign(deltaX) * approachOffset,
		y: yard.y
	} : {
		x: yard.x,
		y: yard.y + Math.sign(deltaY) * approachOffset
	};
	approach.x = Math.max(otherObs.mapMinX, Math.min(otherObs.mapMaxX, approach.x));
	approach.y = Math.max(otherObs.mapMinY, Math.min(otherObs.mapMaxY, approach.y));
	const clampCell = cell => ({
		x: Math.max(otherObs.mapMinX, Math.min(otherObs.mapMaxX, cell.x)),
		y: Math.max(otherObs.mapMinY, Math.min(otherObs.mapMaxY, cell.y))
	});
	const scoutWaypoints = [
		approach,
		{ x: yard.x, y: yard.y + 5 },
		{ x: yard.x, y: yard.y - 5 },
		{ x: yard.x + 5, y: yard.y },
		{ x: yard.x - 5, y: yard.y },
		{ x: yard.x, y: yard.y }
	].map(clampCell).filter((cell, index, cells) =>
		cells.findIndex(other => other.x === cell.x && other.y === cell.y) === index);
	result = await otherSubmit({
		type: 'move',
		actorIds: attackers.map(actor => actor.actorId),
		cellX: approach.x,
		cellY: approach.y,
		queued: false
	});
	assert(result.accepted, `second-agent approach move rejected: ${result.reason}`);
	let approachPolls = 0;
	let approachTarget = approach;
	let approachOrderTick = otherObs.worldTick;
	let nextWaypoint = 1;
	let contactCell;
	const approachObservation = await waitFor('second-agent attackers reach and reveal first base', async () => {
		const candidate = await otherObservation();
		const currentAttackers = attackers.map(actor => candidate.actors.find(current => current.actorId === actor.actorId))
			.filter(actor => actor != null);
		if (++approachPolls % 100 === 0) {
			console.log(`approach tick=${candidate.worldTick} target=${approachTarget.x},${approachTarget.y} ` +
				`actors=${currentAttackers.map(actor => `${actor.cellX},${actor.cellY}`).join(';')}`);
		}

		const visibleStructure = candidate.actors.some(actor => actor.relationship === 'enemy' &&
			['fact', 'powr', 'barr', 'proc'].includes(actor.type));
		if (currentAttackers.length >= 2 && visibleStructure) {
			contactCell = {
				x: Math.round(currentAttackers.reduce((sum, actor) => sum + actor.cellX, 0) / currentAttackers.length),
				y: Math.round(currentAttackers.reduce((sum, actor) => sum + actor.cellY, 0) / currentAttackers.length)
			};
			return candidate;
		}

		if (currentAttackers.length >= 2 && candidate.worldTick - approachOrderTick >= 200) {
			approachTarget = scoutWaypoints[nextWaypoint++ % scoutWaypoints.length];
			otherLastObservation = candidate;
			const replan = await otherSubmit({
				type: 'move',
				actorIds: currentAttackers.map(actor => actor.actorId),
				cellX: approachTarget.x,
				cellY: approachTarget.y,
				queued: false
			});
			assert(replan.accepted, `second-agent scout re-path rejected: ${JSON.stringify(replan)}`);
			approachOrderTick = candidate.worldTick;
		}

		return false;
	}, 240_000, 100);
	attackers = attackers.map(actor => approachObservation.actors.find(current => current.actorId === actor.actorId))
		.filter(actor => actor != null);
	assert(approachObservation.actors.some(actor => actor.relationship === 'enemy' &&
		['fact', 'powr', 'barr', 'proc'].includes(actor.type)),
		`scouts reached the base without observing an enemy structure: ${JSON.stringify(approachObservation.actors)}`);
	assert(approachObservation.spatial.contactLines.some(line => line.startsWith('CONTACT:')) &&
		approachObservation.spatial.grid.some(row => /[E!]/.test(row)),
		`visible contact is missing from the spatial summary: ${JSON.stringify(approachObservation.spatial)}`);

	const retreatVector = { x: otherYard.x - contactCell.x, y: otherYard.y - contactCell.y };
	const retreatScale = 20 / Math.max(1, Math.abs(retreatVector.x), Math.abs(retreatVector.y));
	const memoryCell = {
		x: Math.max(otherObs.mapMinX, Math.min(otherObs.mapMaxX, Math.round(contactCell.x + retreatVector.x * retreatScale))),
		y: Math.max(otherObs.mapMinY, Math.min(otherObs.mapMaxY, Math.round(contactCell.y + retreatVector.y * retreatScale)))
	};
	result = await otherSubmit({
		type: 'move',
		actorIds: attackers.map(actor => actor.actorId),
		cellX: memoryCell.x,
		cellY: memoryCell.y,
		queued: false
	});
	assert(result.accepted, `fog-memory retreat rejected: ${result.reason}`);
	const memoryObservation = await waitFor('scouted structures persist as last-known fog memory', async () => {
		const candidate = await otherObservation();
		return candidate.knownEnemyStructures.length > 0 &&
			!candidate.actors.some(actor => actor.relationship === 'enemy') ? candidate : false;
	}, 120_000, 100);
	assert(memoryObservation.knownEnemyStructures.some(known => ['fact', 'powr', 'barr', 'proc'].includes(known.type)) &&
		memoryObservation.knownEnemyStructures.every(known => !['e1', 'harv'].includes(known.type)),
		`fog memory leaked units or missed structures: ${JSON.stringify(memoryObservation.knownEnemyStructures)}`);
	assert(memoryObservation.spatial.grid.some(row => row.includes('K')) &&
		memoryObservation.spatial.contactLines.some(line => line.includes('remembered enemy structure')),
		`last-known structures are missing from the spatial summary: ${JSON.stringify(memoryObservation.spatial)}`);

	result = await otherSubmit({
		type: 'move',
		actorIds: attackers.map(actor => actor.actorId),
		cellX: contactCell.x,
		cellY: contactCell.y,
		queued: false
	});
	assert(result.accepted, `fog-memory return move rejected: ${result.reason}`);
	otherObs = await waitFor('second-agent attackers return to the first base', async () => {
		const candidate = await otherObservation();
		const returned = attackers.map(actor => candidate.actors.find(current => current.actorId === actor.actorId))
			.filter(actor => actor != null && (actor.cellX - contactCell.x) ** 2 + (actor.cellY - contactCell.y) ** 2 <= 16);
		return returned.length >= 2 ? candidate : false;
	}, 120_000, 100);
	attackers = attackers.map(actor => otherObs.actors.find(current => current.actorId === actor.actorId))
		.filter(actor => actor != null);
	result = await otherSubmit({
		type: 'move',
		actorIds: attackers.map(actor => actor.actorId),
		cellX: otherYard.x,
		cellY: otherYard.y,
		queued: false
	});
	assert(result.accepted, `scouting-wave withdrawal rejected: ${result.reason}`);

	// Rebuild the first agent's refinery so the fixture has both a critical
	// building and a native harvester-flee destination.
	const fixtureReady = await waitFor('fixture proc remains placeable after the march', async () => {
		const candidate = await observation();
		const queue = findQueue(candidate, 'proc');
		const queued = queue?.items.find(item => item.item === 'proc');
		return queued?.placeable ? { obs: candidate, queue, queued } : false;
	});
	fixtureQueue = findQueue(fixtureReady.obs, 'e1');
	assert(fixtureQueue != null, 'first-agent infantry queue disappeared');
	const defendersBefore = fixtureReady.obs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1').length;
	lastObservation = fixtureReady.obs;
	result = await submit({ type: 'startProduction', producerId: fixtureQueue.producerId, item: 'e1', count: 2, queued: false });
	assert(result.accepted, `fixture defender production rejected: ${result.reason}`);
	obs = await waitFor('first-agent reflex defenders appear', async () => {
		const candidate = await observation();
		const infantry = candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1')
			.sort((a, b) => a.actorId - b.actorId).slice(-2);
		return infantry.length === 2 && infantry.every(actor => actor.idle) ? candidate : false;
	});
	const defenders = obs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1')
		.sort((a, b) => a.actorId - b.actorId).slice(-2);
	const leasedDefender = defenders[0];
	const leaseTarget = {
		x: Math.max(obs.mapMinX, Math.min(obs.mapMaxX, leasedDefender.cellX - 7)),
		y: leasedDefender.cellY
	};
	lastObservation = obs;
	result = await submit({ type: 'assignGroup', name: 'base-defense', actorIds: defenders.map(actor => actor.actorId) });
	assert(result.accepted, `defender group assignment rejected: ${JSON.stringify(result)}`);
	lastObservation = await observation();
	result = await submit({ type: 'stop', groupName: 'base-defense' });
	assert(result.accepted, `group-addressed stop rejected: ${JSON.stringify(result)}`);
	lastObservation = await observation();
	result = await submit({
		type: 'move',
		actorIds: [sellablePower.actorId],
		cellX: leaseTarget.x,
		cellY: leaseTarget.y,
		queued: false
	});
	assert(!result.accepted && result.reason === 'actor is stale, missing, or not owned by this agent',
		`all-stale rejection wording changed: ${JSON.stringify(result)}`);
	lastObservation = await observation();
	result = await submit({
		type: 'move',
		actorIds: [leasedDefender.actorId, sellablePower.actorId],
		cellX: leaseTarget.x,
		cellY: leaseTarget.y,
		queued: false
	});
	assert(result.accepted && result.reason ===
		`accepted; skipped 1 stale/invalid ids (${sellablePower.actorId})`,
		`mixed stale/live move did not preserve the live subject: ${JSON.stringify(result)}`);
	const leaseStartTick = obs.worldTick;

	// Keep rally disabled while the ready refinery is placed, so the idle
	// defender remains available for the critical-defense priority.
	lastObservation = await observation();
	result = await submit({
		type: 'setPolicy',
		autoReturnFire: true,
		harvesterFlee: false,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: true,
		autoRepairBuildings: false,
		retreatBelowHpPercent: 0
	});
	assert(result.accepted, `combat standing policy update failed: ${result.reason}`);
	const reflexCursor = (await reflexEvents(agentId)).latestSequence;

	lastObservation = await observation();
	result = await submit({ type: 'placeBuildingAuto', producerId: fixtureReady.queue.producerId, item: 'proc' });
	assert(result.accepted, `fixture refinery placement rejected: ${result.reason}`);
	const fixtureObservation = await waitFor('fixture refinery and harvester appear', async () => {
		const candidate = await observation();
		const refineries = candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'proc');
		const harvesters = candidate.actors.filter(actor => actor.relationship === 'self' && actor.type === 'harv');
		return refineries.length > 0 && harvesters.length > 0 ? candidate : false;
	}, 120_000, 20);
	const fixtureRefinery = fixtureObservation.actors.filter(actor => actor.relationship === 'self' && actor.type === 'proc')
		.sort((a, b) => b.actorId - a.actorId)[0];
	const fixtureHarvester = fixtureObservation.actors.filter(actor => actor.relationship === 'self' && actor.type === 'harv')
		.sort((a, b) => b.actorId - a.actorId)[0];
	// Park the defenders away from the target before the disposable attack
	// wave approaches. The critical-defense reflex may override this lease only
	// after a real HP-drop alert, which makes the fixture deterministic: the
	// attackers get one honest hit before the defenders can engage.
	const liveDefenderIds = defenders.map(actor => actor.actorId)
		.filter(actorId => fixtureObservation.actors.some(actor => actor.actorId === actorId));
	assert(liveDefenderIds.length > 0, 'all critical-defense fixtures disappeared before combat');
	const awayX = Math.sign(fixtureRefinery.cellX - otherYard.x) || 1;
	const defenderPark = {
		x: Math.max(fixtureObservation.mapMinX,
			Math.min(fixtureObservation.mapMaxX, fixtureRefinery.cellX + awayX * 10)),
		y: fixtureRefinery.cellY
	};
	lastObservation = fixtureObservation;
	result = await submit({
		type: 'move', actorIds: liveDefenderIds,
		cellX: defenderPark.x, cellY: defenderPark.y, queued: false
	});
	assert(result.accepted, `defender parking move rejected: ${result.reason}`);
	await waitFor('critical-defense fixtures park away from the target', async () => {
		const candidate = await observation();
		const live = liveDefenderIds.map(actorId => candidate.actors.find(actor => actor.actorId === actorId))
			.filter(actor => actor != null);
		return live.length > 0 && live.every(actor =>
			(actor.cellX - fixtureRefinery.cellX) ** 2 + (actor.cellY - fixtureRefinery.cellY) ** 2 >= 36)
			? candidate : false;
	}, 60_000, 20);
	// Combat assertions use purpose-built waves. The earlier scouts have crossed
	// the map twice and may encounter native defenders at different ticks on
	// Debug and Release builds, so their survival must not gate either reflex.
	attackers = await produceOtherInfantryWave('fresh critical-asset attack wave appears');

	// Rally becomes active only after the leased move and the defenders are in
	// place. Critical defense may override the lease; rally may not.
	lastObservation = await observation();
	result = await submit({
		type: 'setPolicy',
		autoReturnFire: true,
		harvesterFlee: false,
		rallyNewUnitsToDefense: true,
		defendCriticalAssets: true,
		autoRepairBuildings: false,
		retreatBelowHpPercent: 0
	});
	assert(result.accepted, `rally standing policy update failed: ${result.reason}`);
	const combatAudioBaseline = await audioSnapshot();
	assert(combatAudioBaseline.state === 'running' && Number.isInteger(combatAudioBaseline.voicesStarted),
		`audio context was not running before synchronized combat: ${JSON.stringify(combatAudioBaseline)}`);

	// Release builds can advance several ticks between wall-clock polls. This
	// dedicated wave is disposable, so deterministically re-issue the real
	// attack while the visible defenders re-path. Either the
	// refinery or its harvester is a critical asset, so an HP drop on either
	// exercises the same production criticalAssetAttacked edge.
	const criticalHealthBefore = new Map([
		[fixtureRefinery.actorId, fixtureRefinery.health],
		[fixtureHarvester.actorId, fixtureHarvester.health]
	]);
	let attackOrderTick = -200;
	let attackedActorId;
	const attackedObservation = await waitFor('normal attack damages a critical asset', async () => {
		const candidate = await observation();
		const damaged = candidate.actors.find(actor => criticalHealthBefore.has(actor.actorId) &&
			actor.health < criticalHealthBefore.get(actor.actorId));
		if (damaged != null) {
			attackedActorId = damaged.actorId;
			return candidate;
		}

		const attackerView = await otherObservation();
		const survivors = attackers.map(actor => attackerView.actors.find(current => current.actorId === actor.actorId))
			.filter(actor => actor != null);
		assert(survivors.length > 0, 'critical-asset attack wave was destroyed before landing a hit');
		if (attackerView.worldTick - attackOrderTick < 200) {
			return false;
		}

		// Keep the harvester untouched for its independent emergency-flee wave.
		// Advance on the refinery until it becomes visible, then focus it.
		const visibleTarget = [fixtureRefinery]
			.map(target => attackerView.actors.find(actor => actor.relationship === 'enemy' &&
				actor.actorId === target.actorId))
			.find(target => target != null);
		if (visibleTarget != null) {
			result = await otherSubmit({
				type: 'attack',
				actorIds: survivors.map(actor => actor.actorId),
				targetActorId: visibleTarget.actorId,
				queued: false
			});
			assert(result.accepted, `fixture critical-asset attack rejected: ${result.reason}`);
		} else {
			result = await otherSubmit({
				type: 'attackMove',
				actorIds: survivors.map(actor => actor.actorId),
				cellX: fixtureRefinery.cellX,
				cellY: fixtureRefinery.cellY,
				queued: false
			});
			assert(result.accepted, `fixture critical-asset attack-move rejected: ${result.reason}`);
		}

		attackOrderTick = attackerView.worldTick;
		return false;
	}, 120_000, 20);
	await waitFor('synchronized combat starts browser audio voices', async () => {
		const snapshot = await audioSnapshot();
		return snapshot.state === 'running' && snapshot.voicesStarted > combatAudioBaseline.voicesStarted
			? snapshot
			: false;
	}, 30_000, 20);
	const attackedAlert = attackedObservation.alerts.find(alert =>
		alert.kind === 'criticalAssetAttacked' && alert.affectedActorId === attackedActorId);
	assert(attackedAlert != null && attackedAlert.stillActive && attackedAlert.firstSeenTick <= attackedObservation.worldTick,
		`HP-drop alert was not retained for the unresponsive driver: ${JSON.stringify(attackedObservation.alerts)}`);
	due = await waitFor('HP-drop schedules an immediate decision', async () => {
		const candidate = await decisionDue();
		return candidate.due ? candidate : false;
	}, 10_000, 20);
	assert(due.trigger === 'criticalAssetAttacked',
		`attacked-edge decision had the wrong trigger: ${JSON.stringify(due)}`);

	const defenseEvents = await waitFor('critical-defense reflex fires while the driver is unresponsive', async () => {
		const events = await reflexEvents(agentId, reflexCursor);
		return events.events.some(event => event.kind === 'criticalDefense') ? events : false;
	}, 10_000, 20);
	const defenseEvent = defenseEvents.events.find(event => event.kind === 'criticalDefense');
	assert(defenseEvent.worldTick - attackedAlert.firstSeenTick <= 10,
		`critical-defense reflex took ${defenseEvent.worldTick - attackedAlert.firstSeenTick} ticks`);

	// The harvester-flee scenario gets a new wave, independent of the defenders'
	// fate in the HP-drop scenario. Disable strategic defense while the wave
	// approaches so only the emergency harvester policy is under test.
	attackers = await produceOtherInfantryWave('fresh harvester-flee attack wave appears');
	lastObservation = await observation();
	result = await submit({
		type: 'setPolicy',
		autoReturnFire: true,
		harvesterFlee: true,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: false,
		autoRepairBuildings: false,
		retreatBelowHpPercent: 0
	});
	assert(result.accepted, `harvester-flee policy update failed: ${result.reason}`);

	let harvesterApproachTick = -200;
	const harvesterContact = await waitFor('fresh attack wave sees the fixture harvester', async () => {
		const attackerView = await otherObservation();
		const survivors = attackers.map(actor => attackerView.actors.find(current => current.actorId === actor.actorId))
			.filter(actor => actor != null);
		assert(survivors.length > 0, 'harvester-flee attack wave was destroyed before contact');
		if (attackerView.actors.some(actor => actor.relationship === 'enemy' &&
			actor.actorId === fixtureHarvester.actorId)) {
			return { attackerView, survivors };
		}

		if (attackerView.worldTick - harvesterApproachTick >= 200) {
			const currentObservation = await observation();
			const currentHarvester = currentObservation.actors.find(actor => actor.actorId === fixtureHarvester.actorId);
			assert(currentHarvester != null, 'fixture harvester disappeared before its flee scenario');
			result = await otherSubmit({
				type: 'move',
				actorIds: survivors.map(actor => actor.actorId),
				cellX: currentHarvester.cellX,
				cellY: currentHarvester.cellY,
				queued: false
			});
			assert(result.accepted, `harvester approach move rejected: ${result.reason}`);
			harvesterApproachTick = attackerView.worldTick;
		}

		return false;
	}, 120_000, 20);
	await waitFor('harvester attack order is accepted while the target is visible', async () => {
		const attackerView = await otherObservation();
		const survivors = harvesterContact.survivors
			.map(actor => attackerView.actors.find(current => current.actorId === actor.actorId))
			.filter(actor => actor != null);
		assert(survivors.length > 0, 'harvester-flee attack wave was destroyed before issuing its attack');
		const visibleHarvester = attackerView.actors.find(actor => actor.relationship === 'enemy' &&
			actor.actorId === fixtureHarvester.actorId);
		if (visibleHarvester == null) {
			if (attackerView.worldTick - harvesterApproachTick >= 100) {
				const currentObservation = await observation();
				const currentHarvester = currentObservation.actors.find(actor => actor.actorId === fixtureHarvester.actorId);
				assert(currentHarvester != null, 'fixture harvester disappeared before its attack order');
				result = await otherSubmit({
					type: 'move',
					actorIds: survivors.map(actor => actor.actorId),
					cellX: currentHarvester.cellX,
					cellY: currentHarvester.cellY,
					queued: false
				});
				assert(result.accepted, `harvester re-approach move rejected: ${result.reason}`);
				harvesterApproachTick = attackerView.worldTick;
			}

			return false;
		}

		result = await otherSubmit({
			type: 'attack',
			actorIds: survivors.map(actor => actor.actorId),
			targetActorId: fixtureHarvester.actorId,
			queued: false
		});
		if (!result.accepted && result.reason.includes('stale, missing, or not visible')) {
			return false;
		}

		assert(result.accepted, `fixture harvester attack rejected: ${result.reason}`);
		return true;
	}, 60_000, 20);
	const fleeEvents = await waitFor('harvester-flee reflex fires', async () => {
		const events = await reflexEvents(agentId, reflexCursor);
		return events.events.some(event => event.kind === 'harvesterFlee' &&
			event.actorIds.includes(fixtureHarvester.actorId)) ? events : false;
	}, 10_000, 20);
	const fleeEvent = fleeEvents.events.find(event => event.kind === 'harvesterFlee' &&
		event.actorIds.includes(fixtureHarvester.actorId));
	assert(fleeEvent != null, `targeted harvester did not flee: ${JSON.stringify(fleeEvents.events)}`);

	// The flee reflex fires on being targeted, so a fleeing harvester can
	// outrun rifle fire without ever taking a hit — the contested (warning)
	// tier is then the correct factual situation. Asserting the under-attack
	// escalation therefore stages guaranteed damage: hold the harvester
	// still (flee off), keep the attackers on it, and wait for the host to
	// observe a real HP decrease, then restore the flee policy.
	result = await submit({
		type: 'setPolicy',
		autoReturnFire: true,
		harvesterFlee: false,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: false,
		autoRepairBuildings: false,
		retreatBelowHpPercent: 0
	});
	assert(result.accepted, `flee-off policy update failed: ${result.reason}`);
	let lastHarvesterChaseTick = -200;
	await waitFor('standing harvester takes damage and the situation escalates', async () => {
		const attackerView = await otherObservation();
		const survivors = harvesterContact.survivors
			.map(actor => attackerView.actors.find(current => current.actorId === actor.actorId))
			.filter(actor => actor != null);
		assert(survivors.length > 0, 'harvester-escalation attackers were destroyed before damage landed');
		if (attackerView.worldTick - lastHarvesterChaseTick >= 50) {
			lastHarvesterChaseTick = attackerView.worldTick;
			const visibleHarvester = attackerView.actors.find(actor => actor.relationship === 'enemy' &&
				actor.actorId === fixtureHarvester.actorId);
			if (visibleHarvester != null) {
				await otherSubmit({
					type: 'attack',
					actorIds: survivors.map(actor => actor.actorId),
					targetActorId: fixtureHarvester.actorId,
					queued: false
				});
			} else {
				const ownView = await observation();
				const currentHarvester = ownView.actors.find(actor => actor.actorId === fixtureHarvester.actorId);
				assert(currentHarvester != null, 'fixture harvester disappeared before the escalation assertion');
				await otherSubmit({
					type: 'move',
					actorIds: survivors.map(actor => actor.actorId),
					cellX: currentHarvester.cellX,
					cellY: currentHarvester.cellY,
					queued: false
				});
			}
		}

		const candidate = (await observation()).situations.find(situation =>
			situation.id === 'T3.harv' && situation.evidence.assetId === fixtureHarvester.actorId);
		return candidate != null && candidate.severity === 'critical' &&
			candidate.evidence.underAttack === true ? candidate : false;
	}, 90_000, 500);
	result = await submit({
		type: 'setPolicy',
		autoReturnFire: true,
		harvesterFlee: true,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: false,
		autoRepairBuildings: false,
		retreatBelowHpPercent: 0
	});
	assert(result.accepted, `flee-restore policy update failed: ${result.reason}`);

	await waitFor('lease window elapses without rally overriding the explicit move', async () => {
		const candidate = await observation();
		return candidate.worldTick >= leaseStartTick + 75 ? candidate : false;
	}, 30_000, 20);
	const leaseEvents = await reflexEvents(agentId, reflexCursor);
	assert(!leaseEvents.events.some(event => event.kind === 'rally' &&
		event.actorIds.includes(leasedDefender.actorId) && event.worldTick < leaseStartTick + 75),
		`rally reflex overrode actor ${leasedDefender.actorId} during its lease: ${JSON.stringify(leaseEvents.events)}`);

	// Isolate the committed build-plan gate after every combat assertion. Plan-created
	// actors and base geometry therefore cannot perturb the variance-sensitive M2
	// scout/reflex fixture above. Withdraw any surviving attackers before starting.
	otherObs = await otherObservation();
	const withdrawingAttackers = otherObs.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1');
	if (withdrawingAttackers.length > 0) {
		result = await otherSubmit({
			type: 'move',
			actorIds: withdrawingAttackers.map(actor => actor.actorId),
			cellX: otherYard.x,
			cellY: otherYard.y,
			queued: false
		});
		assert(result.accepted, `build-plan isolation withdrawal rejected: ${result.reason}`);
	}

	let quietSinceTick = null;
	await waitFor('build-plan fixture starts after visible combat clears', async () => {
		const candidate = await observation();
		if (candidate.actors.some(actor => actor.relationship === 'enemy')) {
			quietSinceTick = null;
			return false;
		}

		quietSinceTick ??= candidate.worldTick;
		return candidate.worldTick >= quietSinceTick + 50 ? candidate : false;
	}, 120_000, 50);

	// Combat damage can derate a power plant and push the base into low power,
	// multiplying every later production time. Repair through the synchronized
	// public action path before measuring the build-plan state machine so the
	// fixture tests plan logic, not run-to-run combat damage variance.
	let repairBaseline = await observation();
	const damagedBuildings = repairBaseline.actors.filter(actor =>
		actor.relationship === 'self' && actor.capabilities.includes('repair'));
	if (damagedBuildings.length > 0) {
		result = await submit({ type: 'repair', actorIds: damagedBuildings.map(actor => actor.actorId) });
		assert(result.accepted, `build-plan precondition repair rejected: ${result.reason}`);
		repairBaseline = await waitFor('combat-damaged buildings repair before the build plan', async () => {
			const candidate = await observation();
			return !candidate.actors.some(actor => actor.relationship === 'self' && actor.capabilities.includes('repair'))
				? candidate
				: false;
		}, 180_000, 100);
	}
	assert(repairBaseline.hostTruth.economy.powerProvided >= repairBaseline.hostTruth.economy.powerDrained,
		`build-plan fixture remained in low power after repairs: ${JSON.stringify(repairBaseline.hostTruth.economy)}`);
	const planBaseline = await waitFor('build-plan fixture has sufficient cash', async () => {
		const candidate = await observation();
		return candidate.hostTruth.economy.cash + candidate.hostTruth.economy.resources >= 1400 ? candidate : false;
	}, 120_000, 100);
	const baselineInfantryIds = new Set(planBaseline.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1')
		.map(actor => actor.actorId));
	const baselineBarracksIds = new Set(planBaseline.actors.filter(actor => actor.relationship === 'self' && actor.type === 'barr')
		.map(actor => actor.actorId));
	const baselinePowerIds = new Set(planBaseline.actors.filter(actor => actor.relationship === 'self' && actor.type === 'powr')
		.map(actor => actor.actorId));
	const planCursor = (await buildPlanEvents(agentId)).latestSequence;
	const committedPlan = {
		type: 'queueBuildPlan',
		planId: 'gate-opening',
		version: 1,
		reserveCash: 0,
		steps: [
			{ item: 'e1', count: 1 },
			{ item: 'e1', count: 1 },
			{ item: 'e1', count: 1 },
			{ item: 'e1', count: 1 },
			{ item: 'e1', count: 1 },
			{ item: 'e1', count: 1 },
			{ item: 'barr', count: 1 },
			{ item: 'powr', count: 1 }
		]
	};
	lastObservation = planBaseline;
	result = await submit(committedPlan);
	assert(result.accepted && result.reason === "accepted; build plan 'gate-opening' v1 queued",
		`committed build plan was rejected: ${JSON.stringify(result)}`);

	const firstPlanProduction = await waitFor('build plan owns the first production step', async () => {
		const candidate = await observation();
		const plan = candidate.hostTruth.buildPlan;
		return plan?.active && plan.stepIndex === 1 && plan.currentStep?.item === 'e1' && plan.state === 'producing'
			? candidate
			: false;
	});
	const ownedQueue = findQueue(firstPlanProduction, 'e1');
	assert(ownedQueue != null, 'build-plan infantry queue disappeared');
	lastObservation = firstPlanProduction;
	result = await submit({
		type: 'startProduction',
		producerId: ownedQueue.producerId,
		item: 'e1',
		count: 1,
		queued: false
	});
	assert(!result.accepted && /build plan 'gate-opening' owns production queues/.test(result.reason),
		`direct production bypassed build-plan queue ownership: ${JSON.stringify(result)}`);

	const finalStepProduction = await waitFor('build plan reaches its final step with a new barracks', async () => {
		const candidate = await observation();
		const plan = candidate.hostTruth.buildPlan;
		const newBarracks = candidate.actors.find(actor => actor.relationship === 'self' && actor.type === 'barr' &&
			!baselineBarracksIds.has(actor.actorId) && actor.capabilities.includes('sell'));
		return plan?.active && !plan.paused && plan.stepIndex === 8 && plan.currentStep?.item === 'powr' &&
			['producing', 'waitingPlaceable'].includes(plan.state) && newBarracks != null
			? { candidate, newBarracks }
			: false;
	}, 240_000, 50);
	const plannedBarracks = finalStepProduction.newBarracks;
	lastObservation = finalStepProduction.candidate;
	result = await submit({ type: 'sell', actorIds: [plannedBarracks.actorId] });
	assert(result.accepted, `build-plan critical-loss fixture sell rejected: ${result.reason}`);
	const afterPlannedBarracksLoss = await waitFor('build-plan barracks loss auto-pauses the plan', async () => {
		const candidate = await observation();
		const loss = candidate.alerts.find(alert => alert.kind === 'criticalAssetLost' &&
			alert.affectedActorId === plannedBarracks.actorId && alert.buildPlanAutoPaused);
		return !candidate.actors.some(actor => actor.actorId === plannedBarracks.actorId) &&
			candidate.hostTruth.buildPlan?.paused && loss != null
			? { candidate, loss }
			: false;
	}, 120_000, 20);
	assert(afterPlannedBarracksLoss.candidate.hostTruth.buildPlan.pauseReason.includes('criticalAssetLost'),
		`build-plan pause reason did not name the alert: ${JSON.stringify(afterPlannedBarracksLoss.candidate.hostTruth.buildPlan)}`);
	due = await waitFor('build-plan critical loss schedules an immediate decision', async () => {
		const candidate = await decisionDue();
		return candidate.due ? candidate : false;
	}, 10_000, 20);
	assert(due.trigger === 'criticalAssetLost',
		`build-plan critical loss had the wrong decision trigger: ${JSON.stringify(due)}`);

	const pausedPlan = afterPlannedBarracksLoss.candidate.hostTruth.buildPlan;
	const pausedAtTick = afterPlannedBarracksLoss.candidate.worldTick;
	const pausedEventCursor = (await buildPlanEvents(agentId)).latestSequence;
	await waitFor('auto-paused build plan holds without polling or progress', async () => {
		const candidate = await observation();
		const plan = candidate.hostTruth.buildPlan;
		return candidate.worldTick >= pausedAtTick + 50 && plan?.paused &&
			plan.stepIndex === pausedPlan.stepIndex && plan.state === pausedPlan.state
			? candidate
			: false;
	}, 30_000, 20);
	const eventsWhilePaused = await buildPlanEvents(agentId, pausedEventCursor);
	assert(!eventsWhilePaused.events.some(event => ['placing', 'confirmed', 'completed'].includes(event.state)),
		`auto-paused plan advanced without a commander resume: ${JSON.stringify(eventsWhilePaused.events)}`);
	lastObservation = await observation();
	result = await submit({
		type: 'controlBuildPlan',
		planId: 'gate-opening',
		version: 1,
		command: 'resume'
	});
	assert(result.accepted && result.reason === "accepted; build plan 'gate-opening' resumed",
		`build-plan resume rejected: ${JSON.stringify(result)}`);

	const completedPlanObservation = await waitFor('resumed eight-step build plan completes', async () => {
		const candidate = await observation();
		const plan = candidate.hostTruth.buildPlan;
		return plan?.state === 'completed' && !plan.active && !plan.paused ? candidate : false;
	}, 240_000, 50);
	const completedPlan = completedPlanObservation.hostTruth.buildPlan;
	assert(completedPlan.stepIndex === 8 && completedPlan.totalSteps === 8 && completedPlan.currentStep == null,
		`completed plan ledger is inconsistent: ${JSON.stringify(completedPlan)}`);
	const newInfantry = completedPlanObservation.actors.filter(actor => actor.relationship === 'self' && actor.type === 'e1' &&
		!baselineInfantryIds.has(actor.actorId));
	const newPower = completedPlanObservation.actors.filter(actor => actor.relationship === 'self' && actor.type === 'powr' &&
		!baselinePowerIds.has(actor.actorId));
	assert(newInfantry.length >= 6, `build plan did not confirm six infantry: ${JSON.stringify(newInfantry)}`);
	assert(newPower.length >= 1, 'build plan did not confirm its final power plant');
	assert(!completedPlanObservation.actors.some(actor => actor.actorId === plannedBarracks.actorId),
		'build-plan critical-loss barracks returned after being sold');

	const planTrace = (await buildPlanEvents(agentId, planCursor)).events;
	assert(planTrace.length > 0 && !planTrace.some(event => /failed|did not complete|disappeared/i.test(event.reason)),
		`build-plan trace contains an execution error: ${JSON.stringify(planTrace)}`);
	for (let stepIndex = 1; stepIndex <= 8; stepIndex++) {
		const transitions = planTrace.filter(event => event.stepIndex === stepIndex &&
			!/auto-paused|resumed by commander/.test(event.reason));
		for (const requiredState of ['planned', 'waitingPrerequisites', 'waitingCash', 'producing', 'confirmed']) {
			assert(transitions.filter(event => event.state === requiredState).length === 1,
				`step ${stepIndex} did not transition through ${requiredState} exactly once: ${JSON.stringify(transitions)}`);
		}

		if (stepIndex >= 7) {
			for (const requiredState of ['waitingPlaceable', 'placing']) {
				assert(transitions.filter(event => event.state === requiredState).length === 1,
					`building step ${stepIndex} did not transition through ${requiredState} exactly once: ${JSON.stringify(transitions)}`);
			}
		}
	}
	assert(planTrace.filter(event => event.state === 'completed').length === 1,
		`build plan did not emit one terminal completion: ${JSON.stringify(planTrace)}`);

	const finalState = await state();
	assert(!finalState.outOfSync, `final state desynced: ${JSON.stringify(finalState)}`);
	console.log(`A2A GATE RESULT: PASS tick=${finalState.worldTick} net=${finalState.netFrame}`);
} catch (error) {
	console.error('A2A GATE FAILED:', error.message);
	process.exitCode = 1;
} finally {
	try {
		await page.evaluate(() => globalThis.ora?.StopAgentMatch());
	} catch {
		// The primary assertion is preserved if the host already stopped.
	}

	await browser.close();
	server.kill();
}
