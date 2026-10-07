#!/usr/bin/env node

// Deterministic browser regression for exact rejection-repair actions.
// A cancel-first repair must validate its retry before cancelling the active
// build plan, and a stale repair must not remain pending after rejection.
// Usage: node rejection-repair-gate.mjs [--headed]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const headed = args.includes('--headed');
if (args.some(arg => arg !== '--headed') || new Set(args).size !== args.length) {
	console.error('usage: node rejection-repair-gate.mjs [--headed]');
	process.exit(2);
}

const port = 8368;
const serverUrl = `http://127.0.0.1:${port}/`;
const gameUrl = `${serverUrl}index.html?mode=game&platform=webgl2&Host.DevContent=1&Host.AgentMode=1&` +
	'Launch.Map=Siberian-Pass.oramap&Debug.ServerRandomSeed=60718';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let browser;
let page;
let decisionId = 1;

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

async function call(method, ...methodArgs) {
	const text = await page.evaluate(({ method, methodArgs }) =>
		globalThis.ora[method](...methodArgs), { method, methodArgs });
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

async function submitOne(agentId, action, thoughts = 'Exercise exact rejection-repair atomicity.') {
	const obs = await observation(agentId);
	const value = await call('SubmitAgentActions', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId: decisionId++,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts,
		memo: '',
		actions: [action]
	}));
	assert(value.results?.length === 1, `unexpected action result: ${JSON.stringify(value)}`);
	return value.results[0];
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
	throw new Error(`TIMEOUT ${label}; latest=${JSON.stringify(latest)?.slice(0, 1000)}`);
}

function pendingRepair(obs) {
	return obs.hostTruth.doctrine.pendingDecision?.kind === 'rejectionRepair'
		? obs.hostTruth.doctrine.pendingDecision
		: null;
}

try {
	assert(await probe(serverUrl) == null, `port ${port} is already in use`);
	const startup = { listening: false, stderr: '', error: null };
	server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(port)], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.once('error', error => { startup.error = error; });
	server.stdout.on('data', chunk => {
		if (String(chunk).includes('[server] serving ')) startup.listening = true;
	});
	server.stderr.on('data', chunk => { startup.stderr = `${startup.stderr}${String(chunk)}`.slice(-2000); });
	await waitFor('owned bundle server', async () => {
		if (startup.error != null) throw startup.error;
		if (server.exitCode != null || server.signalCode != null)
			throw new Error(`bundle server exited: ${startup.stderr}`);
		return startup.listening && await probe(serverUrl) === 200;
	}, 10_000, 100);

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
	const agentId = started.agentIds[0];
	await waitFor('regular executor world', async () => {
		const current = await state();
		return current.state === 'running' && current.worldTick >= 25 ? current : false;
	});

	let obs = await observation(agentId);
	const mcv = obs.actors.find(actor => actor.relationship === 'self' && actor.capabilities.includes('deploy'));
	assert(mcv != null, 'no deployable MCV observed');
	let result = await submitOne(agentId, { type: 'deploy', actorIds: [mcv.actorId] });
	assert(result.accepted, `MCV deploy rejected: ${result.reason}`);
	obs = await waitFor('construction yard', async () => {
		const candidate = await observation(agentId);
		return candidate.base.yards.length !== 0 ? candidate : false;
	});
	result = await submitOne(agentId, {
		type: 'queueBuildPlan',
		planId: 'repair-atomicity',
		version: 1,
		reserveCash: 0,
		steps: [{ item: 'powr', count: 1 }]
	});
	assert(result.accepted, `build plan rejected: ${result.reason}`);
	obs = await waitFor('build plan owns the construction queue', async () => {
		const candidate = await observation(agentId);
		const plan = candidate.hostTruth.buildPlan;
		return plan?.active && plan.planId === 'repair-atomicity' && plan.version === 1 &&
			plan.state === 'producing' && candidate.productionQueues.some(queue =>
				queue.buildableItems.includes('powr')) ? candidate : false;
	});
	const reservedProducerId = obs.productionQueues.find(queue => queue.buildableItems.includes('powr')).producerId;
	const eventCursor = (await call('GetAgentBuildPlanEvents', agentId, 0)).latestSequence;

	const impossibleRetry = {
		type: 'startProduction', producerId: reservedProducerId, item: 'e2', count: 1, queued: false
	};
	result = await submitOne(agentId, impossibleRetry);
	assert(!result.accepted && /reserved by build plan|cancel-first/.test(result.reason),
		`direct production did not produce build-plan guidance: ${JSON.stringify(result)}`);
	const offeredRepair = result.nextLegalActions?.find(option => option.optionId === 'repair-cancel-plan-first');
	assert(offeredRepair != null && offeredRepair.actions?.length === 2 &&
		offeredRepair.actions[0].type === 'controlBuildPlan' && offeredRepair.actions[1].item === 'e2',
		`cancel-first exact repair was not offered: ${JSON.stringify(result.nextLegalActions)}`);

	obs = await observation(agentId);
	let repair = pendingRepair(obs);
	assert(repair != null && repair.decisionId === offeredRepair.decisionId,
		`repair decision was not persisted: ${JSON.stringify(obs.hostTruth.doctrine.pendingDecision)}`);
	result = await submitOne(agentId, {
		type: 'acceptDoctrineDecision', decisionId: repair.decisionId,
		optionId: 'repair-cancel-plan-first'
	});
	assert(!result.accepted && result.reason.includes('selected option is no longer legal') &&
		result.reason.includes(`cannot build 'e2'`),
		`impossible exact retry failed unexpectedly: ${JSON.stringify(result)}`);
	assert(!result.nextLegalActions?.some(option => option.optionId === 'repair-cancel-plan-first'),
		`stale exact repair was returned again: ${JSON.stringify(result.nextLegalActions)}`);

	obs = await observation(agentId);
	assert(obs.hostTruth.buildPlan?.active && obs.hostTruth.buildPlan.planId === 'repair-atomicity' &&
		obs.hostTruth.buildPlan.version === 1 && obs.hostTruth.buildPlan.state !== 'cancelled',
		`failed exact retry cancelled or replaced the plan: ${JSON.stringify(obs.hostTruth.buildPlan)}`);
	assert(pendingRepair(obs) == null,
		`failed exact retry remained pending: ${JSON.stringify(obs.hostTruth.doctrine.pendingDecision)}`);
	let events = await call('GetAgentBuildPlanEvents', agentId, eventCursor);
	assert(!events.events.some(event => event.state === 'cancelled'),
		`failed exact retry emitted a cancellation: ${JSON.stringify(events.events)}`);
	console.log('OK impossible retry is atomic and stale repair is discarded');

	// Recreate the same guidance, then answer it with an ordinary accepted model
	// action. Opportunistic rejection repair must never trap subsequent responses.
	result = await submitOne(agentId, impossibleRetry);
	assert(!result.accepted && result.nextLegalActions?.some(option =>
		option.optionId === 'repair-cancel-plan-first'),
		`second repair fixture was not created: ${JSON.stringify(result)}`);
	obs = await observation(agentId);
	repair = pendingRepair(obs);
	assert(repair != null, 'second rejection repair did not become pending');
	result = await submitOne(agentId, {
		type: 'setPolicy',
		autoReturnFire: true,
		harvesterFlee: true,
		rallyNewUnitsToDefense: false,
		defendCriticalAssets: true,
		autoRepairBuildings: false,
		retreatBelowHpPercent: 0
	}, 'Answer opportunistic repair with a valid direct model action.');
	assert(result.accepted, `valid direct response was rejected: ${result.reason}`);
	obs = await observation(agentId);
	assert(pendingRepair(obs) == null,
		`valid direct response did not resolve rejection repair: ${JSON.stringify(obs.hostTruth.doctrine.pendingDecision)}`);

	const clearTick = obs.worldTick;
	obs = await waitFor('repair stays cleared past its old rearm boundary', async () => {
		const candidate = await observation(agentId);
		return candidate.worldTick >= clearTick + 110 ? candidate : false;
	}, 30_000, 25);
	assert(pendingRepair(obs) == null,
		`rejection repair reappeared after rearm: ${JSON.stringify(obs.hostTruth.doctrine.pendingDecision)}`);
	events = await call('GetAgentBuildPlanEvents', agentId, eventCursor);
	assert(!events.events.some(event => event.state === 'cancelled'),
		`build plan was cancelled after direct resolution: ${JSON.stringify(events.events)}`);
	const finalState = await state();
	console.log(`REJECTION REPAIR GATE: PASS tick=${finalState.worldTick} net=${finalState.netFrame}`);
} catch (error) {
	console.error('REJECTION REPAIR GATE FAILED:', error.message);
	process.exitCode = 1;
} finally {
	try { await page?.evaluate(() => globalThis.ora?.StopAgentMatch()); } catch { /* preserve primary result */ }
	await browser?.close();
	await stopChild(server);
}
