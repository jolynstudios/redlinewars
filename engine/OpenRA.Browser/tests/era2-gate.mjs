// Era 2 browser gate: advisor fallback attribution and the real Normal-AI seat.
// Runs only synchronized host actions; no test-only world mutation surface.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const port = 8359;
const url = `http://127.0.0.1:${port}/index.html?mode=game&platform=webgl2&Host.DevContent=1&Host.AgentMode=1&` +
	'Launch.Map=Siberian-Pass.oramap&Debug.ServerRandomSeed=34567';
const serverUrl = `http://127.0.0.1:${port}/`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let browser;
let page;
let cleanupPromise;

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

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
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

async function waitFor(label, predicate, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	while (Date.now() < deadline) {
		latest = await predicate();
		if (latest) {
			console.log(`OK ${label}`);
			return latest;
		}

		await new Promise(resolve => setTimeout(resolve, 50));
	}

	throw new Error(`TIMEOUT ${label}; latest=${JSON.stringify(latest)}`);
}

async function start(config) {
	const result = await call('StartAgentMatch', '', JSON.stringify({
		schemaVersion: 1,
		fakeAgents: false,
		decisionIntervalTicks: 100,
		faction1: 'russia',
		faction2: 'russia',
		...config
	}));
	await waitFor('regular world', async () => {
		const state = await call('GetAgentMatchState');
		return state.state === 'running' && state.worldTick >= 25 ? state : false;
	});
	return result;
}

async function observation(agentId) {
	return call('GetAgentObservation', agentId, 0);
}

async function stop() {
	await page.evaluate(() => globalThis.ora.StopAgentMatch());
	await new Promise(resolve => setTimeout(resolve, 250));
}

async function buildAndPlace(agentId, item, decisionId) {
	let obs = await waitFor(`${item} becomes buildable`, async () => {
		const candidate = await observation(agentId);
		return candidate.productionQueues.some(queue => queue.buildableItems.includes(item)) ? candidate : false;
	});
	const queue = obs.productionQueues.find(candidate => candidate.buildableItems.includes(item));
	assert(queue != null, `no queue can build ${item}: ${JSON.stringify(obs.productionQueues)}`);
	let result = await call('SubmitAgentActions', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts: `Prepare Allied fallback fixture: ${item}.`,
		actions: [{ type: 'startProduction', producerId: queue.producerId, item, count: 1 }]
	}));
	assert(result.accepted === 1, `startProduction ${item} was rejected: ${JSON.stringify(result)}`);

	obs = await waitFor(`${item} becomes placeable`, async () => {
		const candidate = await observation(agentId);
		return candidate.productionQueues.some(q => q.items.some(entry => entry.item === item && entry.placeable))
			? candidate : false;
	}, 180_000);
	const readyQueue = obs.productionQueues.find(candidate =>
		candidate.items.some(entry => entry.item === item && entry.placeable));
	result = await call('SubmitAgentActions', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: decisionId + 1,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts: `Place Allied fallback fixture: ${item}.`,
		actions: [{ type: 'placeBuildingAuto', producerId: readyQueue.producerId, item }]
	}));
	assert(result.accepted === 1, `placeBuildingAuto ${item} was rejected: ${JSON.stringify(result)}`);
	await waitFor(`${item} appears`, async () => {
		const candidate = await observation(agentId);
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === item) ? candidate : false;
	});
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

	browser = await chromium.launch({ headless: true });
	page = await browser.newPage();
	page.on('console', message => {
		if (/FATAL|FAIL|PASS|AGENT/i.test(message.text())) {
			console.log(`[console] ${message.text().slice(0, 240)}`);
		}
	});
	await page.goto(url);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => globalThis.ora.IsRunning(), undefined, { timeout: 60_000 });

	for (const opponentBot of ['agent', 'not-a-real-bot']) {
		const rejected = await raw('StartAgentMatch', '', JSON.stringify({ schemaVersion: 1, opponentBot }));
		assert(rejected.value?.error, `opponentBot ${opponentBot} was not rejected: ${rejected.text}`);
	}
	console.log('OK invalid and reserved bot ids reject before server creation');

	let match = await start({ advisorFallbackEnabled: false });
	let agentId = match.agentIds[0];
	let obs = await observation(agentId);
	let disabled = await raw('SubmitAgentFallback', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: 1,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		kind: 'timeout',
		reason: 'gate timeout'
	}));
	assert(disabled.value?.error?.includes('disabled'), `disabled fallback was accepted: ${disabled.text}`);
	let result = await call('SubmitAgentActions', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: 1,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts: 'Deliberate empty action batch.',
		actions: []
	}));
	assert(!result.fallback && result.fallbackTurns === 0 && result.decisionOpportunities === 1,
		`raw no-op fallback accounting is wrong: ${JSON.stringify(result)}`);
	await stop();

	match = await start({ advisorFallbackEnabled: true });
	agentId = match.agentIds[0];
	obs = await observation(agentId);
	const firstIdentity = { sequence: obs.sequence, worldTick: obs.worldTick };
	result = await call('SubmitAgentFallback', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: 1,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		kind: 'timeout',
		reason: 'gate timeout'
	}));
	assert(result.fallback && result.accepted === 1 && result.results[0]?.type === 'deploy' &&
		result.fallbackTurns === 1 && result.decisionOpportunities === 1,
		`first fallback did not deploy the MCV: ${JSON.stringify(result)}`);

	obs = await waitFor('fallback deployment creates a Construction Yard', async () => {
		const candidate = await observation(agentId);
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === 'fact') ? candidate : false;
	});
	const badSequence = await raw('SubmitAgentFallback', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: 2,
		observedSequence: obs.sequence + 1000,
		observedWorldTick: obs.worldTick,
		kind: 'schema',
		reason: 'gate invalid sequence'
	}));
	assert(badSequence.value?.error?.includes('unknown observation sequence'),
		`invalid fallback identity was accepted: ${badSequence.text}`);

	result = await call('SubmitAgentFallback', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: 2,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		kind: 'schema',
		reason: 'gate schema failure'
	}));
	assert(result.fallback && result.accepted === 1 && result.results[0]?.type === 'startProduction' &&
		result.results[0]?.accepted && result.fallbackTurns === 2 && result.decisionOpportunities === 2,
		`second fallback did not bootstrap power: ${JSON.stringify(result)}`);
	const duplicate = await raw('SubmitAgentFallback', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: 2,
		observedSequence: firstIdentity.sequence,
		observedWorldTick: firstIdentity.worldTick,
		kind: 'upstream',
		reason: 'gate duplicate'
	}));
	assert(duplicate.value?.error, `duplicate fallback was accepted: ${duplicate.text}`);
	const fallbackState = await call('GetAgentMatchState');
	assert(fallbackState.agents[0].fallbackTurns === 2 && fallbackState.agents[0].decisionOpportunities === 2,
		`terminal-safe fallback counters are wrong: ${JSON.stringify(fallbackState.agents[0])}`);
	await stop();

	match = await start({ advisorFallbackEnabled: true, faction1: 'england', faction2: 'england' });
	agentId = match.agentIds[0];
	obs = await observation(agentId);
	result = await call('SubmitAgentFallback', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: 1,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		kind: 'timeout',
		reason: 'Allied bootstrap fixture'
	}));
	assert(result.results[0]?.type === 'deploy' && result.results[0]?.accepted,
		`Allied fallback did not deploy its MCV: ${JSON.stringify(result)}`);
	await waitFor('Allied fallback deployment creates a Construction Yard', async () => {
		const candidate = await observation(agentId);
		return candidate.actors.some(actor => actor.relationship === 'self' && actor.type === 'fact') ? candidate : false;
	});
	await buildAndPlace(agentId, 'powr', 2);
	await buildAndPlace(agentId, 'proc', 4);
	obs = await observation(agentId);
	result = await call('SubmitAgentFallback', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: 6,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		kind: 'schema',
		reason: 'Allied infantry-production fixture'
	}));
	assert(result.results[0]?.type === 'startProduction' && result.results[0]?.accepted,
		`Allied fallback did not choose tent: ${JSON.stringify(result)}`);
	await waitFor('Allied fallback queues the Allied tent rather than Soviet barracks', async () => {
		const candidate = await observation(agentId);
		return candidate.productionQueues.some(queue => queue.items.some(item => item.item === 'tent')) &&
			!candidate.productionQueues.some(queue => queue.items.some(item => item.item === 'barr'));
	});
	await stop();

	match = await start({ opponentBot: 'normal', omniscientObservations: true });
	assert(match.agentIds.length === 1 && match.opponentBot === 'normal',
		`Normal bot start contract is wrong: ${JSON.stringify(match)}`);
	agentId = match.agentIds[0];
	let versusBotState = await waitFor('Normal bot maps as the second participant', async () => {
		const candidate = await call('GetAgentMatchState');
		return candidate.agents[0]?.clientIndex >= 0 && candidate.opponent?.clientIndex >= 0 ? candidate : false;
	});
	assert(versusBotState.agents[0].controllerType === 'llm' && versusBotState.opponent.controllerType === 'normal',
		`participant controller attribution is wrong: ${JSON.stringify(versusBotState)}`);
	await waitFor('Normal bot issues synchronized orders and deploys its MCV', async () => {
		const candidate = await observation(agentId);
		return candidate.actors.some(actor => actor.relationship === 'enemy' && actor.type === 'fact') ? candidate : false;
	}, 180_000);
	obs = await observation(agentId);
	result = await call('SubmitAgentActions', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: 1,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts: 'Resolve the Normal-bot baseline fixture.',
		actions: [{ type: 'surrender' }]
	}));
	assert(result.accepted === 1, `surrender was rejected: ${JSON.stringify(result)}`);
	versusBotState = await waitFor('agent loss and Normal-bot win resolve terminal state', async () => {
		const candidate = await call('GetAgentMatchState');
		return candidate.state === 'finished' ? candidate : false;
	});
	assert(!versusBotState.outOfSync && versusBotState.agents[0].winState === 'Lost' &&
		versusBotState.opponent.winState === 'Won', `Normal-bot outcome is wrong: ${JSON.stringify(versusBotState)}`);
	await stop();

	match = await start({});
	const restarted = await call('GetAgentMatchState');
	assert(match.agentIds.length === 2 && restarted.opponent == null && restarted.opponentBot == null &&
		!restarted.advisorFallbackEnabled && restarted.agents.every(agent =>
			agent.fallbackTurns === 0 && agent.decisionOpportunities === 0),
		`restart retained Era 2 state: ${JSON.stringify(restarted)}`);
	console.log('ERA2 GATE RESULT: PASS');
} catch (error) {
	console.error('ERA2 GATE FAILED:', error.message);
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
