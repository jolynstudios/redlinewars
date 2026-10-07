// Shared no-spend fixture for the Phase-2 benchmark-lockstep gates. It owns
// both loopback servers, uses a scripted sidecar (never OpenRouter), and opens
// a fresh browser runtime for every latency schedule so the engine seed and
// barrier identities start from the same state.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RulesKnowledgeHash } from '../agent-sidecar/dist/instructions.js';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
export const BenchmarkSpecVersion = 'benchmark-lockstep-v1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function assert(condition, message) {
	if (!condition)
		throw new Error(message);
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

function sendJson(response, status, value, origin) {
	if (origin)
		response.setHeader('Access-Control-Allow-Origin', origin);
	response.writeHead(status, {
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json; charset=utf-8'
	});
	response.end(JSON.stringify(value));
}

async function readJson(request) {
	const chunks = [];
	for await (const chunk of request)
		chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function scriptedBatch(input, actions = []) {
	return {
		schemaVersion: 1,
		decisionId: input.decisionId,
		observedSequence: input.observation.sequence,
		observedWorldTick: input.observation.worldTick,
		thoughts: 'Scripted benchmark-lockstep gate response.',
		memo: '',
		actions
	};
}

async function listen(server, port) {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
}

function createScriptedSidecar(port) {
	let schedule = () => ({});
	let requests = [];
	const server = createServer(async (request, response) => {
		const origin = request.headers.origin;
		if (request.method === 'OPTIONS') {
			if (origin)
				response.setHeader('Access-Control-Allow-Origin', origin);
			response.writeHead(204, {
				'Access-Control-Allow-Headers': 'Content-Type',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
			});
			response.end();
			return;
		}

		const url = new URL(request.url ?? '/', 'http://sidecar.invalid');
		if (request.method === 'POST' && url.pathname === '/api/estimate') {
			const input = await readJson(request);
			const agents = input.models.map(model => ({
				model, prompt: 0, completion: 0, request: 0,
				perDecisionUsd: 0, estimatedInputTokens: input.estimatedInputTokens
			}));
			sendJson(response, 200, {
				agents,
				estimatedMatchUsd: 0,
				assumptions: input,
				knowledgeChars: 0,
				rulesKnowledgeHash: RulesKnowledgeHash,
				arsenalContextChars: 0
			}, origin);
			return;
		}

		if (request.method !== 'POST' || url.pathname !== '/api/decide') {
			sendJson(response, 404, { error: 'not found' }, origin);
			return;
		}

		const input = await readJson(request);
		const seat = String(input.agentId).startsWith('agent-1-') ? 0 : 1;
		const plan = schedule({ input, seat }) ?? {};
		const record = {
			seat,
			agentId: input.agentId,
			decisionId: input.decisionId,
			phase: input.phase ?? 'live',
			receivedAt: Date.now(),
			respondedAt: null,
			closedAt: null,
			status: plan.status ?? 200
		};
		requests.push(record);
		response.once('close', () => { record.closedAt = Date.now(); });
		await delay(Math.max(0, Number(plan.delayMs) || 0));
		if (response.destroyed)
			return;
		record.respondedAt = Date.now();
		if ((plan.status ?? 200) !== 200) {
			sendJson(response, plan.status, {
				error: plan.error ?? 'Scripted worker-fatal response.',
				costUsd: 0,
				attempts: []
			}, origin);
			return;
		}

		const actions = typeof plan.actions === 'function' ? plan.actions(input) : plan.actions ?? [];
		sendJson(response, 200, {
			batch: scriptedBatch(input, actions),
			usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, costUsd: 0 },
			attempts: [{ label: 'strict', durationMs: Math.max(0, Number(plan.delayMs) || 0),
				outcome: 'ok', finishReason: 'stop', reasoningTokens: 0, outputBytes: 64 }],
			durationMs: Math.max(0, Number(plan.delayMs) || 0)
		}, origin);
	});

	return {
		url: `http://127.0.0.1:${port}`,
		server,
		configure(next) {
			schedule = next;
			requests = [];
		},
		requests() {
			return requests.map(item => ({ ...item }));
		}
	};
}

async function waitForOwnedServer(child, startup, serverUrl) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (startup.error != null)
			throw new Error(`Could not start bundle server: ${startup.error.message}`);
		if (child.exitCode != null || child.signalCode != null)
			throw new Error(`Bundle server exited before readiness: ${startup.stderr.trim().slice(-500)}`);
		if (startup.listening && await probe(serverUrl) === 200)
			return;
		await delay(100);
	}
	throw new Error(`Bundle server did not become ready at ${serverUrl}.`);
}

function benchmarkUrl(serverUrl, options) {
	const params = new URLSearchParams({
		mode: 'game',
		platform: 'webgl2',
		'Host.DevContent': '1',
		'Host.AgentMode': '1',
		'Host.BenchmarkLockstep': '1',
		'Host.PrematchPlanning': '1',
		'Host.BenchmarkDecisionTimeoutMs': String(options.timeoutMs ?? 10_000),
		'Host.BenchmarkTickHorizon': String(options.tickHorizon ?? 5000),
		'Host.BenchmarkDecisionHorizon': String(options.decisionHorizon ?? 4),
		'Host.GameSpeed': 'fastest',
		'Launch.Map': 'Siberian-Pass.oramap',
		'Debug.ServerRandomSeed': String(options.seed ?? 73123)
	});
	return `${serverUrl}index.html?${params}`;
}

async function pageSnapshot(page) {
	return page.evaluate(() => {
		const parse = text => {
			try { return JSON.parse(text); } catch { return {}; }
		};
		return {
			state: parse(globalThis.ora.GetAgentMatchState()),
			barrier: parse(globalThis.ora.GetAgentLockstepBarrier()),
			trace: globalThis.oraLastLockstepTrace ?? [],
			metrics: globalThis.__lockstepGateMetrics ?? null,
			lastResolved: globalThis.oraLastResolvedMatchState ?? null,
			netFrame: globalThis.ora.GetNetFrame(),
			status: document.getElementById('agent-match-status')?.textContent ?? ''
		};
	});
}

async function waitFor(label, predicate, timeoutMs = 180_000, intervalMs = 25) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	while (Date.now() < deadline) {
		latest = await predicate();
		if (latest)
			return latest;
		await delay(intervalMs);
	}
	throw new Error(`TIMEOUT ${label}; latest=${JSON.stringify(latest)}`);
}

async function instrumentLockstepExports(page) {
	const installed = await page.evaluate(() => {
		const metrics = globalThis.__lockstepGateMetrics = { commits: [], aborts: [] };
		const wrap = (name, sink) => {
			const original = globalThis.ora[name];
			try {
				globalThis.ora[name] = (...args) => {
					const returned = original(...args);
					sink.push({ at: Date.now(), request: args[0] ?? null, returned });
					return returned;
				};
			} catch {
				return false;
			}
			return globalThis.ora[name] !== original;
		};
		return wrap('CommitAgentLockstepBarrier', metrics.commits) &&
			wrap('AbortAgentLockstepBarrier', metrics.aborts);
	});
	assert(installed, 'public lockstep exports could not be instrumented');
}

async function configureAndStart(page, sidecarUrl) {
	await page.evaluate(config => {
		const preset = document.getElementById('agent-preset');
		if (preset) preset.value = 'raw';
		document.getElementById('agent-key-1').value = 'scripted-no-network-key';
		document.getElementById('agent-key-2').value = 'scripted-no-network-key';
		document.getElementById('agent-sidecar').value = config.sidecarUrl;
		document.getElementById('agent-model-1').value = 'scripted/model-a';
		document.getElementById('agent-model-2').value = 'scripted/model-b';
		document.getElementById('agent-map').value = 'Siberian-Pass.oramap';
		document.getElementById('agent-spend-cap').value = '10';
		document.getElementById('agent-interval').value = '500';
		document.getElementById('agent-max-tokens').value = '4096';
		document.getElementById('agent-start').click();
	}, { sidecarUrl });
	await waitFor('benchmark match start', async () => {
		const snapshot = await pageSnapshot(page);
		if (snapshot.lastResolved?.terminalKind != null)
			throw new Error(`scripted benchmark failed to start: ${JSON.stringify(snapshot.lastResolved)}`);
		if (/failed|error|drifted|requires an explicit map/i.test(snapshot.status))
			throw new Error(`scripted benchmark start rejected: ${snapshot.status}`);
		return ['planning', 'starting', 'running'].includes(snapshot.state.state) ? snapshot : false;
	}, 240_000, 50);
}

export async function createBenchmarkHarness({ bundlePort, sidecarPort, headed = false }) {
	const serverUrl = `http://127.0.0.1:${bundlePort}/`;
	if (await probe(serverUrl) != null)
		throw new Error(`Port ${bundlePort} is already serving HTTP.`);
	if (await probe(`http://127.0.0.1:${sidecarPort}/`) != null)
		throw new Error(`Port ${sidecarPort} is already serving HTTP.`);

	const startup = { listening: false, stderr: '', error: null };
	const bundleServer = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(bundlePort)], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	bundleServer.once('error', error => { startup.error = error; });
	bundleServer.stdout.on('data', chunk => {
		if (String(chunk).includes('[server] serving ')) startup.listening = true;
	});
	bundleServer.stderr.on('data', chunk => {
		startup.stderr = `${startup.stderr}${String(chunk)}`.slice(-2000);
	});
	await waitForOwnedServer(bundleServer, startup, serverUrl);

	const sidecar = createScriptedSidecar(sidecarPort);
	await listen(sidecar.server, sidecarPort);
	const browser = await chromium.launch({ headless: !headed });

	return {
		sidecar,
		async runScenario(name, schedule, options = {}) {
			sidecar.configure(schedule);
			const page = await browser.newPage();
			const pageErrors = [];
			page.on('pageerror', error => pageErrors.push(String(error)));
			await page.goto(benchmarkUrl(serverUrl, options), { waitUntil: 'domcontentloaded', timeout: 240_000 });
			await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
			await page.waitForFunction(() => {
				try { return globalThis.ora.IsRunning(); } catch { return false; }
			}, undefined, { timeout: 60_000 });
			await instrumentLockstepExports(page);
			await configureAndStart(page, sidecar.url);

			const samples = [];
			let firstLiveCollectingAt = null;
			let firstAppliedObservedAt = null;
			const live = await waitFor(`${name} live barrier resolution`, async () => {
				const snapshot = await pageSnapshot(page);
				if (snapshot.state.outOfSync)
					throw new Error(`${name} desynced: ${JSON.stringify(snapshot.state)}`);
				if (snapshot.state.state === 'failed')
					throw new Error(`${name} failed: ${snapshot.state.terminalReason}`);
				if (snapshot.barrier.barrierId === 1 && snapshot.barrier.phase === 'Collecting') {
					firstLiveCollectingAt ??= Date.now();
					samples.push({ at: Date.now(), ...snapshot.barrier });
				}
				const trace = snapshot.trace.find(entry => entry.barrierId === 1 && entry.closedWorldTick >= 0);
				if (trace != null) {
					firstAppliedObservedAt ??= Date.now();
					return { snapshot, trace };
				}
				return false;
			}, options.scenarioTimeoutMs ?? 180_000, 20);

			const result = {
				name,
				page,
				state: live.snapshot.state,
				trace: live.snapshot.trace,
				liveTrace: live.trace,
				samples,
				firstLiveCollectingAt,
				firstAppliedObservedAt,
				metrics: live.snapshot.metrics,
				requests: sidecar.requests(),
				pageErrors
			};
			if (options.keepPage !== true) {
				await page.evaluate(() => document.getElementById('agent-stop')?.click());
				await page.close();
				result.page = null;
			}
			return result;
		},
		async newPageScenario(schedule, options = {}) {
			sidecar.configure(schedule);
			const page = await browser.newPage();
			await page.goto(benchmarkUrl(serverUrl, options), { waitUntil: 'domcontentloaded', timeout: 240_000 });
			await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
			await page.waitForFunction(() => {
				try { return globalThis.ora.IsRunning(); } catch { return false; }
			}, undefined, { timeout: 60_000 });
			await instrumentLockstepExports(page);
			await configureAndStart(page, sidecar.url);
			return page;
		},
		pageSnapshot,
		waitFor,
		async close() {
			await Promise.allSettled([
				browser.close(),
				new Promise(resolve => sidecar.server.close(resolve)),
				stopChild(bundleServer)
			]);
		}
	};
}

export function canonicalBarrierTrace(trace) {
	return trace.map(barrier => ({
		barrierId: barrier.barrierId,
		prematch: barrier.prematch,
		triggerWorldTick: barrier.triggerWorldTick,
		frozenWorldTick: barrier.frozenWorldTick,
		appliedWorldTick: barrier.appliedWorldTick,
		closedWorldTick: barrier.closedWorldTick,
		resumed: barrier.resumed,
		commitDigest: barrier.commitDigest,
		seats: barrier.seats.map(seat => ({
			ordinal: seat.ordinal,
			decisionId: seat.decisionId,
			triggerSource: seat.triggerSource,
			trigger: seat.trigger,
			status: seat.status,
			outcome: seat.outcome
		}))
	}));
}
