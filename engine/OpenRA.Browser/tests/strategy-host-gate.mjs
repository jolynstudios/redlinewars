#!/usr/bin/env node

// Era 3 strategy-host gate: default-off config, strict typed validation,
// model-owned adoption/switching, bounded event history, and host-truth state.
// Uses only public Agent mode APIs and normal synchronized orders.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const headed = args.includes('--headed');
if (args.some(arg => arg !== '--headed') || new Set(args).size !== args.length) {
	console.error('usage: node strategy-host-gate.mjs [--headed]');
	process.exit(2);
}

const port = 8365;
const serverUrl = `http://127.0.0.1:${port}/`;
const url = `${serverUrl}index.html?mode=game&platform=webgl2&Host.DevContent=1&Host.AgentMode=1&` +
	'Launch.Map=Siberian-Pass.oramap&Debug.ServerRandomSeed=45678';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let browser;
let page;
let cleanupPromise;

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
	cleanupPromise ??= Promise.allSettled([
		browser == null ? Promise.resolve() : Promise.resolve().then(() => browser.close()),
		stopChild(server)
	]);
	return cleanupPromise;
}

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

async function waitForRunning() {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const current = await call('GetAgentMatchState');
		if (current.outOfSync) {
			throw new Error(`DESYNC at tick ${current.worldTick}, net ${current.netFrame}`);
		}
		if (current.state === 'running' && current.worldTick >= 25) {
			return current;
		}
		await delay(50);
	}
	throw new Error('Agent match did not reach the strategy warmup boundary.');
}

async function observation(agentId) {
	return call('GetAgentObservation', agentId, 0);
}

async function submit(agentId, decisionId, obs, actions) {
	return raw('SubmitAgentActions', agentId, JSON.stringify({
		schemaVersion: 1,
		decisionId,
		observedSequence: obs.sequence,
		observedWorldTick: obs.worldTick,
		thoughts: 'Exercise the model-owned strategy selection boundary.',
		memo: '',
		actions
	}));
}

async function start(enabled) {
	const started = await call('StartAgentMatch', '', JSON.stringify({
		schemaVersion: 1,
		fakeAgents: false,
		decisionIntervalTicks: 500,
		faction1: 'russia',
		faction2: 'russia',
		strategyArsenalEnabled: enabled
	}));
	assert(started.strategyArsenalEnabled === enabled,
		`start result lost strategyArsenalEnabled=${enabled}: ${JSON.stringify(started)}`);
	await waitForRunning();
	return started.agentIds[0];
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
	server.stderr.on('data', chunk => { startup.stderr = `${startup.stderr}${String(chunk)}`.slice(-2000); });
	await waitForOwnedServer(server, startup);

	browser = await chromium.launch({ headless: !headed });
	page = await browser.newPage();
	page.on('pageerror', error => console.error('[pageerror]', String(error)));
	await page.goto(url);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } },
		undefined, { timeout: 60_000 });

	let agentId = await start(false);
	let obs = await observation(agentId);
	assert(obs.hostTruth.strategy?.enabled === false && obs.hostTruth.strategy.strategyId == null,
		`default-off host truth is wrong: ${JSON.stringify(obs.hostTruth.strategy)}`);
	let response = await submit(agentId, 1, obs, [
		{ type: 'adoptStrategy', strategyId: 'soviet-tank-pressure', reason: 'Probe the disabled boundary.' }
	]);
	assert(response.value.results?.[0]?.accepted === false &&
		response.value.results[0].reason === 'strategy arsenal is disabled for this match',
		`default-off adoption was not rejected: ${response.text}`);
	await page.evaluate(() => globalThis.ora.StopAgentMatch());
	console.log('OK strategy arsenal is default-off and host truth says so');

	agentId = await start(true);
	obs = await observation(agentId);
	assert(obs.hostTruth.strategy?.enabled === true && obs.hostTruth.strategy.strategyId == null &&
		obs.hostTruth.strategy.adoptedTick === -1 && obs.hostTruth.strategy.lastSwitchTick === -1,
		`enabled pre-adoption host truth is wrong: ${JSON.stringify(obs.hostTruth.strategy)}`);
	const schema = await call('GetAgentActionSchema');
	assert(schema.arsenal?.enabled === true && schema.arsenal.catalogVersion === 1 &&
		/^[0-9a-f]{64}$/.test(schema.arsenal.catalogFileHash) &&
		/^[0-9a-f]{64}$/.test(schema.arsenal.manualFileHash),
		`strategy schema/hash pins are missing: ${JSON.stringify(schema.arsenal)}`);

	response = await submit(agentId, 1, obs, [
		{ type: 'adoptStrategy', strategyId: 'missing-strategy', reason: 'Reject unknown IDs.' }
	]);
	assert(response.value.results?.[0]?.reason === "unknown strategyId 'missing-strategy'",
		`unknown strategy id was not rejected: ${response.text}`);
	response = await submit(agentId, 2, obs, [
		{ type: 'adoptStrategy', strategyId: 'allied-fast-boom', reason: 'Reject faction mismatch.' }
	]);
	assert(response.value.results?.[0]?.reason.includes("requires faction 'allies'"),
		`faction mismatch was not rejected: ${response.text}`);
	response = await submit(agentId, 3, obs, [
		{ type: 'adoptStrategy', strategyId: 'soviet-tank-pressure', reason: 'Reject impure fields.', item: 'e1' }
	]);
	assert(response.value.results?.[0]?.reason === 'adoptStrategy requires only strategyId and reason',
		`strategy field purity was not enforced: ${response.text}`);
	response = await submit(agentId, 4, obs, [
		{ type: 'adoptStrategy', strategyId: 'soviet-tank-pressure', reason: 'Select a factual pressure doctrine.' }
	]);
	assert(response.value.results?.[0]?.accepted === true,
		`valid strategy adoption was rejected: ${response.text}`);

	let stateObs = await observation(agentId);
	assert(stateObs.hostTruth.strategy.strategyId === 'soviet-tank-pressure' &&
		stateObs.hostTruth.strategy.cardVersion === 2 && stateObs.hostTruth.strategy.catalogVersion === 1 &&
		stateObs.hostTruth.strategy.adoptedTick >= obs.worldTick &&
		stateObs.hostTruth.strategy.lastSwitchTick === -1 && stateObs.hostTruth.strategy.switchCount === 0 &&
		stateObs.hostTruth.strategy.modelReason === 'Select a factual pressure doctrine.',
		`adopted strategy host truth is wrong: ${JSON.stringify(stateObs.hostTruth.strategy)}`);
	response = await submit(agentId, 5, stateObs, [
		{ type: 'adoptStrategy', strategyId: 'soviet-tank-pressure', reason: 'Try duplicate selection.' }
	]);
	assert(response.value.results?.[0]?.reason ===
		"strategy 'soviet-tank-pressure' is already active; update memo instead",
		`re-adoption guidance changed: ${response.text}`);

	response = await submit(agentId, 6, stateObs, [
		{ type: 'adoptStrategy', strategyId: 'soviet-grenadier-rush', reason: 'Switch to grenadier rush.' },
		{ type: 'adoptStrategy', strategyId: 'soviet-tank-pressure', reason: 'Illegal second strategy.' }
	]);
	assert(response.value.error === 'an action batch may contain at most one adoptStrategy action',
		`strategy cardinality did not reject wholesale: ${response.text}`);

	// Reuse one honest observation: observed identities may be stale but never
	// future, and strategy actions issue no simulation orders. Alternating valid
	// IDs exercises deterministic switch accounting and the 128-entry ring.
	let decisionId = 7;
	for (let index = 0; index < 130; index++) {
		const strategyId = index % 2 === 0 ? 'soviet-grenadier-rush' : 'soviet-tank-pressure';
		response = await submit(agentId, decisionId++, stateObs, [
			{ type: 'adoptStrategy', strategyId, reason: `Bounded event switch ${index + 1}.` }
		]);
		assert(response.value.results?.[0]?.accepted === true,
			`valid strategy switch ${index + 1} was rejected: ${response.text}`);
	}

	const events = await call('GetAgentStrategyEvents', agentId, 0);
	assert(events.events.length === 128 && events.latestSequence === 131 && events.events[0].sequence === 4,
		`strategy event ring is not bounded to its newest 128 entries: ${JSON.stringify(events).slice(0, 800)}`);
	let previous = 3;
	for (const event of events.events) {
		assert(event.sequence > previous && ['adopted', 'switched'].includes(event.kind) &&
			Number.isInteger(event.cardVersion) && event.catalogVersion === 1 &&
			typeof event.modelReason === 'string' && event.modelReason.length <= 240,
			`strategy event is invalid: ${JSON.stringify(event)}`);
		previous = event.sequence;
	}
	stateObs = await observation(agentId);
	assert(stateObs.hostTruth.strategy.switchCount === 130 &&
		stateObs.hostTruth.strategy.lastSwitchTick >= stateObs.hostTruth.strategy.adoptedTick,
		`strategy switch accounting is wrong: ${JSON.stringify(stateObs.hostTruth.strategy)}`);
	const matchState = await call('GetAgentMatchState');
	assert(matchState.strategyArsenalEnabled === true && !matchState.outOfSync,
		`strategy match state is wrong: ${JSON.stringify(matchState)}`);
	console.log(`STRATEGY HOST GATE: PASS tick=${matchState.worldTick} net=${matchState.netFrame}`);
} catch (error) {
	console.error('STRATEGY HOST GATE FAILED:', error.message);
	process.exitCode = 1;
} finally {
	try {
		await page?.evaluate(() => globalThis.ora?.StopAgentMatch());
	} catch {
		// Preserve the primary failure.
	}
	await cleanup();
}
